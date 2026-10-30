from dotenv import dotenv_values
import pytest

from scripts.configure_google import configure


def test_google_setup_preserves_database_and_other_settings(tmp_path):
    path = tmp_path / ".env"
    path.write_text("# local config\nDATABASE_URL='unchanged-test-value'\nFRONTEND_ORIGIN=http://localhost:5173\n", encoding="utf-8")
    configure(path, "123-example.apps.googleusercontent.com", "example-secret")
    values = dotenv_values(path)
    assert values["DATABASE_URL"] == "unchanged-test-value"
    assert values["FRONTEND_ORIGIN"] == "http://localhost:5173"
    assert values["GOOGLE_CLIENT_SECRET"] == "example-secret"
    configure(path, "456-example.apps.googleusercontent.com", "replacement")
    assert path.read_text().count("GOOGLE_CLIENT_SECRET=") == 1


@pytest.mark.parametrize("client,secret", [
    ("bad-id", "secret"),
    ("123.apps.googleusercontent.com", ""),
    ("123.apps.googleusercontent.com", "secret\nINJECTED=yes"),
])
def test_invalid_google_setup_does_not_modify_file(tmp_path, client, secret):
    path = tmp_path / ".env"
    path.write_text("DATABASE_URL=unchanged\n")
    with pytest.raises(ValueError):
        configure(path, client, secret)
    assert path.read_text() == "DATABASE_URL=unchanged\n"


def test_google_setup_requires_existing_env(tmp_path):
    path = tmp_path / ".env"
    with pytest.raises(ValueError):
        configure(path, "123.apps.googleusercontent.com", "secret")
    assert not path.exists()
