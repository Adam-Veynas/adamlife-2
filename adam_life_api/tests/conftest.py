import pytest

from app.config import Settings


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    # Unit tests must not accidentally read a developer's credentials/configuration.
    for field in Settings.model_fields:
        monkeypatch.delenv(field.upper(), raising=False)


@pytest.fixture
def settings():
    return Settings(_env_file=None, app_env="test")
