"""WhisperLink OSS — pytest coverage for accounts, CSRF, and audible-only constraints.
Author: Antonio Brandao
License: MIT
"""
import pathlib
import re

import pytest

from chirp_oss import create_app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CHIRP_INSTANCE", str(tmp_path))
    monkeypatch.setenv("CHIRP_DB", str(tmp_path / "users.db"))
    monkeypatch.setenv("CHIRP_SECRET_KEY", "test-secret-oss")
    monkeypatch.delenv("APPLICATION_ROOT", raising=False)
    app = create_app({"TESTING": True})
    return app.test_client()


def csrf(client, url="/login"):
    html = client.get(url).get_data(as_text=True)
    return re.search(r'name="_csrf" value="([^"]+)"', html).group(1)


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.get_json()["edition"] == "oss"


def test_demo_login_and_room_audible_only(client):
    tok = csrf(client)
    r = client.post("/login", data={"_csrf": tok, "username": "demo", "password": "demo-change-me"})
    assert r.status_code == 302
    page = client.get("/room").get_data(as_text=True)
    assert client.get("/room").status_code == 200
    assert 'data-modes="FAST,ROBUST"' in page
    assert "INAUDIBLE" not in page
    assert "Chat" in page and "Spectrum" in page


def test_admin_login(client):
    tok = csrf(client)
    r = client.post("/login", data={"_csrf": tok, "username": "admin", "password": "admin-change-me"})
    assert r.status_code == 302
    assert client.get("/dashboard").status_code == 200


def test_alice_bob_seeds(client):
    for user, pw in (("alice", "alice-change-me"), ("bob", "bob-change-me")):
        client.get("/logout")  # may 400 without csrf; clear via session
        with client.session_transaction() as s:
            s.clear()
        tok = csrf(client)
        r = client.post("/login", data={"_csrf": tok, "username": user, "password": pw})
        assert r.status_code == 302, user


def test_register_and_csrf(client):
    assert client.post("/register", data={"username": "x"}).status_code == 400
    tok = csrf(client, "/register")
    r = client.post(
        "/register",
        data={"_csrf": tok, "username": "carol", "password": "CarolPass!99", "password2": "CarolPass!99"},
    )
    assert r.status_code == 302
    assert client.get("/dashboard").status_code == 200


def test_no_crypto_or_inaudible_in_oss_static():
    root = pathlib.Path(__file__).resolve().parents[1] / "chirp_oss" / "static" / "js"
    js = "".join(p.read_text() for p in root.glob("*.js"))
    assert "crypto.subtle" not in js
    assert "INAUDIBLE" not in js
    assert "Ed25519" not in js
