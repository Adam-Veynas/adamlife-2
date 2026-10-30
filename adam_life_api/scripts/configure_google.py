"""Interactive local-only configuration. Never print or accept secrets on the command line."""
from getpass import getpass
from pathlib import Path
import re

from dotenv import set_key

ROOT = Path(__file__).resolve().parents[1]


def configure(path: Path, client_id: str, secret: str) -> None:
    if not path.is_file():
        raise ValueError("First prepare the local .env with setup-local.cmd")
    if not re.fullmatch(r"[A-Za-z0-9_-]+\.apps\.googleusercontent\.com", client_id):
        raise ValueError("Use the Google Web application client ID")
    if not secret or len(secret) > 1024 or not secret.isascii() or any(c.isspace() for c in secret):
        raise ValueError("Client secret must be nonempty ASCII without whitespace")
    # dotenv preserves unrelated settings, including existing database credentials.
    set_key(path, "GOOGLE_CLIENT_ID", client_id, quote_mode="always")
    set_key(path, "GOOGLE_CLIENT_SECRET", secret, quote_mode="always")


def main():
    print("Google Web application. Redirect: http://localhost:5173/api/auth/google/callback")
    print("Enter credentials here, not in chat. Secret input is hidden.")
    client_id = input("Client ID: ").strip()
    secret = getpass("Client secret: ").strip()
    configure(ROOT / ".env", client_id, secret)
    print("Saved locally. Restart the backend, then open http://localhost:5173/")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled.")
        raise SystemExit(1)
    except ValueError as exc:
        print(str(exc))
        raise SystemExit(1)
    except OSError:
        print("Could not save local configuration. Check file permissions; credentials were not printed.")
        raise SystemExit(1)
