import json
from pathlib import Path

import pytest
from sqlalchemy.engine import make_url

from scripts import local_env


@pytest.fixture
def local_paths(tmp_path, monkeypatch):
    local = tmp_path / ".local"
    monkeypatch.setattr(local_env, "LOCAL", local)
    monkeypatch.setattr(local_env, "DATA", local / "pgdata")
    monkeypatch.setattr(local_env, "STATE", local / "local-settings.json")
    return local


def test_local_credentials_are_generated_once_without_output(local_paths, capsys):
    first = local_env.state(create=True)
    assert len(set(first["passwords"].values())) == 5
    assert all(len(value) >= 40 for value in first["passwords"].values())
    assert local_env.state(create=True) == first
    assert capsys.readouterr().out == ""


def test_unknown_existing_data_directory_is_never_adopted(local_paths):
    data = local_paths / "pgdata"
    data.mkdir(parents=True)
    sentinel = data / "existing-user-data"
    sentinel.write_text("must remain", encoding="utf-8")
    with pytest.raises(RuntimeError, match="Refusing to adopt"):
        local_env.state(create=True)
    assert sentinel.read_text(encoding="utf-8") == "must remain"
    assert not local_env.STATE.exists()


def test_private_configuration_never_overwrites_existing_file(tmp_path):
    target = tmp_path / ".env"
    local_env.private_create(target, "existing data")
    with pytest.raises(FileExistsError):
        local_env.private_create(target, "replacement")
    assert target.read_text(encoding="utf-8") == "existing data"


def test_cluster_moved_to_another_project_is_not_silently_reused(local_paths):
    saved = local_env.state(create=True)
    saved["data_directory"] = "different-project"
    local_env.STATE.write_text(json.dumps(saved), encoding="utf-8")
    with pytest.raises(RuntimeError, match="does not match"):
        local_env.state()


def test_native_path_refers_to_same_directory(tmp_path):
    assert Path(local_env.native_path(tmp_path)).samefile(tmp_path)


def test_logging_redacts_all_generated_passwords(local_paths):
    saved = local_env.state(create=True)
    payload = " ".join(saved["passwords"].values())
    result = local_env.redact(payload, saved)
    assert not any(password in result for password in saved["passwords"].values())
    assert result.count("<redacted>") == 5


def test_connection_urls_use_separate_users_and_databases(local_paths):
    saved = local_env.state(create=True)
    development = make_url(local_env.database_url(saved, "adamlife_app", "adamlife"))
    tests = make_url(local_env.database_url(saved, "adamlife_test_owner", "adamlife_test"))
    assert development.host == tests.host == "127.0.0.1"
    assert development.port == tests.port == 55432
    assert development.username != tests.username
    assert development.database != tests.database


@pytest.mark.parametrize("verified", [True, False])
def test_running_server_is_verified_without_process_visibility(local_paths, monkeypatch, verified):
    saved = local_env.state(create=True)
    local_env.DATA.mkdir()
    (local_env.DATA / "adamlife-local-cluster.marker").write_text("test", encoding="utf-8")

    class OpenPort:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def settimeout(self, value):
            pass

        def connect_ex(self, address):
            assert address == ("127.0.0.1", local_env.PORT)
            return 0

    checked = []

    def verify(value):
        checked.append(value)
        if not verified:
            raise RuntimeError("different cluster")

    def forbidden(*args, **kwargs):
        pytest.fail("An occupied port must never cause a server process to be started or stopped")

    monkeypatch.setattr(local_env.socket, "socket", OpenPort)
    monkeypatch.setattr(local_env, "verify_cluster", verify)
    monkeypatch.setattr(local_env.subprocess, "run", forbidden)
    if verified:
        local_env.start(saved)
    else:
        with pytest.raises(RuntimeError, match="no server was changed"):
            local_env.start(saved)
    assert checked == [saved]
