"""Manage ONLY AdamLife's own user-local PostgreSQL cluster. Never reset databases.

Generated credentials/config are runtime artifacts in ignored local files, not source.
No password is printed, passed in command-line arguments, or sent to external services.
"""
import argparse
import ctypes
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys

import psycopg
from psycopg import sql
from sqlalchemy.engine import URL

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / ".local"
BIN = LOCAL / "pgsql" / "bin"
DATA = LOCAL / "pgdata"
STATE = LOCAL / "local-settings.json"
ENV_MARKER = "# Managed by AdamLife scripts/local_env.py; local secrets, do not share."
ADMIN = "adamlife_local_admin"
ROLES = (ADMIN, "adamlife_migrator", "adamlife_app", "adamlife_test_owner", "adamlife_test_app")
DATABASES = {"adamlife": "adamlife_migrator", "adamlife_test": "adamlife_test_owner"}
PORT = 55432


def native_path(path: Path) -> str:
    """Avoid PostgreSQL/Windows non-ASCII path bugs without moving user files."""
    if os.name != "nt":
        return str(path)
    buffer = ctypes.create_unicode_buffer(32768)
    if ctypes.windll.kernel32.GetShortPathNameW(str(path), buffer, len(buffer)):
        return buffer.value
    if not path.exists() and path.parent.exists():
        return str(Path(native_path(path.parent)) / path.name)
    return str(path)


def private_create(path: Path, content: str) -> None:
    """Create without overwriting an existing file; no credentials in tool arguments."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
        stream.write(content)


def state(create=False) -> dict:
    if STATE.exists():
        saved = json.loads(STATE.read_text(encoding="utf-8"))
        if saved.get("data_directory") != str(DATA) or saved.get("port") != PORT:
            raise RuntimeError("Local cluster configuration does not match this project; nothing was changed")
        return saved
    if not create:
        raise RuntimeError("Run prepare first to create the isolated local environment")
    if DATA.exists() and any(DATA.iterdir()):
        raise RuntimeError("Refusing to adopt an existing PostgreSQL data directory")
    LOCAL.mkdir(exist_ok=True)
    saved = {"version": 1, "data_directory": str(DATA), "port": PORT,
             "passwords": {role: secrets.token_urlsafe(36) for role in ROLES}}
    private_create(STATE, json.dumps(saved, indent=2))
    return saved


def connection(saved, role=ADMIN, database="postgres"):
    return psycopg.connect(host="127.0.0.1", port=PORT, dbname=database, user=role,
                           password=saved["passwords"][role], connect_timeout=3, sslmode="disable",
                           autocommit=True, client_encoding="UTF8")


def database_url(saved, role, database):
    return URL.create("postgresql+psycopg", username=role, password=saved["passwords"][role],
                      host="127.0.0.1", port=PORT, database=database).render_as_string(hide_password=False)


def child_environment(saved):
    env = dict(os.environ)
    env.update(APP_ENV="development",
               DATABASE_URL=database_url(saved, "adamlife_app", "adamlife"),
               MIGRATION_DATABASE_URL=database_url(saved, "adamlife_migrator", "adamlife"),
               TEST_DATABASE_URL=database_url(saved, "adamlife_test_owner", "adamlife_test"),
               TEST_RUNTIME_DATABASE_URL=database_url(saved, "adamlife_test_app", "adamlife_test"),
               ADAMLIFE_ALLOW_TEST_DATABASE_RESET="1", PYTHONUTF8="1", TZ="UTC",
               TEMP=native_path(ROOT / ".tmp"), TMP=native_path(ROOT / ".tmp"))
    (ROOT / ".tmp").mkdir(exist_ok=True)
    return env


def redact(text, saved):
    for password in saved["passwords"].values():
        text = text.replace(password, "<redacted>")
    return text


def command(args, saved, *, quiet=False):
    args = [native_path(arg) if isinstance(arg, Path) else str(arg) for arg in args]
    if Path(str(args[0])).name == "initdb.exe":
        # initdb reports only progress and filenames, never the password file contents.
        result = subprocess.run(args, cwd=native_path(ROOT), env=child_environment(saved),
                                timeout=120)
        if result.returncode:
            raise RuntimeError(f"initdb failed (exit {result.returncode})")
        return result
    if Path(args[0]).name == "pg_ctl.exe":
        # A background postgres process can inherit pipe handles on Windows.
        # Waiting for pipe EOF can then hang even after pg_ctl has exited.
        # A file keeps diagnostics without waiting for the server to close its handles.
        output_path = LOCAL / f"pg-control-{secrets.token_hex(8)}.log"
        with output_path.open("x", encoding="utf-8") as output:
            result = subprocess.run(args, cwd=native_path(ROOT), env=child_environment(saved),
                                    stdout=output, stderr=subprocess.STDOUT, timeout=120,
                                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        result.stdout = output_path.read_text(encoding="utf-8", errors="replace")
        result.stderr = ""
    else:
        result = subprocess.run(args, cwd=native_path(ROOT), env=child_environment(saved),
                                capture_output=True, encoding="utf-8", errors="replace",
                                timeout=120,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    if not quiet or result.returncode:
        for output in [result.stdout, result.stderr]:
            if output.strip():
                print(redact(output, saved), end="" if output.endswith("\n") else "\n")
    if result.returncode:
        raise RuntimeError(f"Command {Path(str(args[0])).name} failed (exit {result.returncode})")
    return result


def verify_cluster(saved):
    with connection(saved) as conn:
        actual = conn.execute("SHOW data_directory").fetchone()[0]
        if not Path(actual).samefile(DATA):
            raise RuntimeError("Port belongs to a different PostgreSQL cluster; refusing to change it")


def initialize(saved):
    if (DATA / "PG_VERSION").exists():
        if not (DATA / "adamlife-local-cluster.marker").exists():
            raise RuntimeError("Refusing to use an unmarked pre-existing PostgreSQL cluster")
        return
    if DATA.exists() and any(DATA.iterdir()):
        raise RuntimeError("Incomplete or unknown data directory; refusing to delete or reinitialize it")
    if not (BIN / "initdb.exe").exists():
        raise RuntimeError("Install the local PostgreSQL binaries with install-local-postgres.ps1 first")
    pwfile = LOCAL / "initdb-password.tmp"
    private_create(pwfile, saved["passwords"][ADMIN] + "\n")
    try:
        command([BIN / "initdb.exe", "-D", DATA, "-U", ADMIN, "--pwfile", pwfile,
                 "--encoding=UTF8", "--locale=C", "--auth=scram-sha-256"], saved)
        private_create(DATA / "adamlife-local-cluster.marker", "AdamLife isolated local cluster\n")
    finally:
        pwfile.unlink(missing_ok=True)  # Only our generated short-lived password file.


def start(saved):
    if not (DATA / "adamlife-local-cluster.marker").exists():
        raise RuntimeError("Local cluster has not been initialized")
    # Process visibility differs between Explorer and the Windows sandbox.
    # Authenticate and verify the actual cluster instead of trusting pg_ctl status.
    with socket.socket() as probe:
        probe.settimeout(1)
        if probe.connect_ex(("127.0.0.1", PORT)) == 0:
            try:
                verify_cluster(saved)
            except (psycopg.Error, OSError, RuntimeError):
                raise RuntimeError(f"Port {PORT} is occupied but the AdamLife cluster could not be verified; no server was changed") from None
            print(f"AdamLife PostgreSQL is already running on 127.0.0.1:{PORT}")
            return
    options = (f"-h 127.0.0.1 -p {PORT} -c shared_buffers=64MB -c max_connections=40 "
               "-c password_encryption=scram-sha-256 -c log_statement=none "
               "-c log_min_error_statement=panic -c log_parameter_max_length_on_error=0")
    command([BIN / "pg_ctl.exe", "-D", DATA, "-l", LOCAL / "postgres.log", "-o", options,
             "-w", "-t", "25", "start"], saved)
    verify_cluster(saved)
    print(f"AdamLife PostgreSQL started on 127.0.0.1:{PORT}; not exposed to the LAN")


def provision(saved):
    verify_cluster(saved)
    with connection(saved) as conn:
        for role in ROLES[1:]:
            existing = conn.execute("SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=%s",
                                    (role,)).fetchone()
            if existing is not None:
                if any(existing):
                    raise RuntimeError(f"Existing role {role} is privileged; refusing to change it")
                continue
            conn.execute(sql.SQL("CREATE ROLE {} LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS")
                         .format(sql.Identifier(role), sql.Literal(saved["passwords"][role])))
        for database, owner in DATABASES.items():
            existing = conn.execute("SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=%s", (database,)).fetchone()
            if existing is not None:
                if existing[0] != owner:
                    raise RuntimeError(f"Existing database {database} has another owner; nothing was deleted")
                continue
            conn.execute(sql.SQL("CREATE DATABASE {} OWNER {} ENCODING 'UTF8'").format(sql.Identifier(database), sql.Identifier(owner)))
            conn.execute(sql.SQL("REVOKE ALL ON DATABASE {} FROM PUBLIC").format(sql.Identifier(database)))
            runtime = "adamlife_app" if database == "adamlife" else "adamlife_test_app"
            conn.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(sql.Identifier(database), sql.Identifier(runtime)))
    # Test runtime connectivity without changing any pre-existing credentials.
    for database, owner in DATABASES.items():
        with connection(saved, owner, database) as conn:
            conn.execute("SELECT 1")
    env_file = ROOT / ".env"
    if env_file.exists():
        if not env_file.read_text(encoding="utf-8").startswith(ENV_MARKER):
            raise RuntimeError("Existing .env is not managed by this setup; refusing to overwrite it")
    else:
        env = child_environment(saved)
        private_create(env_file, ENV_MARKER + "\n" + "\n".join(f"{key}={env[key]}" for key in [
            "APP_ENV", "DATABASE_URL", "MIGRATION_DATABASE_URL", "TEST_DATABASE_URL", "TEST_RUNTIME_DATABASE_URL",
        ]) + '\nCORS_ORIGINS=["http://localhost:5173","http://127.0.0.1:5173"]\n'
          + 'TRUSTED_HOSTS=["localhost","127.0.0.1","testserver"]\n')
    print("Separate development/test databases and private .env are ready; passwords were not printed")


def migrate(saved):
    start(saved)
    command([sys.executable, "-m", "alembic", "upgrade", "head"], saved)
    with connection(saved, "adamlife_migrator", "adamlife") as conn:
        conn.execute((ROOT / "scripts/grant-runtime.sql").read_text(encoding="utf-8"))
    command([sys.executable, "-m", "alembic", "current"], saved)
    command([sys.executable, "-m", "alembic", "check"], saved)


def check(saved):
    verify_cluster(saved)
    with connection(saved, "adamlife_app", "adamlife") as conn:
        version = conn.execute("SHOW server_version").fetchone()[0]
        revision = conn.execute("SELECT version_num FROM alembic_version").fetchone()[0]
        role = conn.execute("SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user").fetchone()
        print(f"PostgreSQL {version}; revision {revision}; role {role[0]}; superuser={role[1]}; bypassrls={role[2]}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "start", "stop", "migrate", "test", "serve", "check"])
    action = parser.parse_args().action
    saved = state(create=action == "prepare")
    if action == "prepare":
        print("Checking the existing cluster / initializing only if absent...", flush=True)
        initialize(saved)
        print("Checking PostgreSQL connection / starting if stopped...", flush=True)
        start(saved)
        print("Preparing development and test databases...", flush=True)
        provision(saved)
        print("Applying and checking migrations...", flush=True)
        migrate(saved)
        check(saved)
    elif action == "start":
        start(saved)
    elif action == "stop":
        verify_cluster(saved)
        command([BIN / "pg_ctl.exe", "-D", DATA, "-m", "fast", "-w", "-t", "25", "stop"], saved)
    elif action == "migrate":
        migrate(saved)
    elif action == "test":
        start(saved)
        command([sys.executable, "-m", "pytest", "-q"], saved)
    elif action == "serve":
        start(saved)
        subprocess.run([sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000", "--no-access-log"],
                       cwd=ROOT, env=child_environment(saved), check=True)
    else:
        check(saved)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Never print SQL, connection parameters, or a traceback containing credentials.
        print(f"Local environment action failed ({type(exc).__name__}).", file=sys.stderr)
        if isinstance(exc, RuntimeError):
            print(str(exc), file=sys.stderr)
        sys.exit(1)
