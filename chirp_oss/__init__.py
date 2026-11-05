"""WhisperLink OSS — data-over-sound web app (audible modes, TCP-like ACK session, no encryption).
Author: Antonio Brandao
License: MIT

The Flask server only handles accounts and serves the WebAudio modem;
peers exchange data acoustically (speaker -> microphone), never through this server.
"""
from __future__ import annotations

import os
import secrets
import sqlite3
import time
from functools import wraps
from pathlib import Path

from flask import (Flask, abort, flash, g, redirect, render_template, request,
                   session, url_for)
from werkzeug.security import check_password_hash, generate_password_hash

EDITION = "oss"
APP_NAME = "WhisperLink OSS"
DEFAULT_PREFIX = ""


def normalize_root(value: str | None) -> str:
    raw = (value or "").strip()
    if raw.lower() in {"", "off", "none", "/"}:
        return ""
    if not raw.startswith("/"):
        raw = "/" + raw
    return raw.rstrip("/")


class PrefixMiddleware:
    """Mount under a sub-path behind nginx (works whether nginx strips the prefix or not)."""

    def __init__(self, app, prefix: str):
        self.app, self.prefix = app, normalize_root(prefix)

    def __call__(self, environ, start_response):
        if self.prefix:
            path = environ.get("PATH_INFO", "") or ""
            if path == self.prefix or path.startswith(self.prefix + "/"):
                environ["PATH_INFO"] = path[len(self.prefix):] or "/"
            environ["SCRIPT_NAME"] = self.prefix
        return self.app(environ, start_response)


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  pw_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  must_change INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login INTEGER
);
"""


def create_app(config: dict | None = None) -> Flask:
    pkg = Path(__file__).resolve().parent
    app = Flask(__name__, instance_path=str(Path(os.environ.get("CHIRP_INSTANCE", pkg.parent / "instance")).resolve()))
    Path(app.instance_path).mkdir(parents=True, exist_ok=True)
    secret = os.environ.get("CHIRP_SECRET_KEY")
    if not secret:
        key_file = Path(app.instance_path) / "secret_key"
        if not key_file.exists():
            key_file.write_text(secrets.token_hex(32))
            key_file.chmod(0o600)
        secret = key_file.read_text().strip()
    app.config.update(
        SECRET_KEY=secret,
        DATABASE=os.environ.get("CHIRP_DB", str(Path(app.instance_path) / "users.db")),
        ALLOW_REGISTRATION=os.environ.get("CHIRP_ALLOW_REGISTRATION", "1") not in {"0", "false", "no"},
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=os.environ.get("CHIRP_COOKIE_SECURE", "0") in {"1", "true", "yes"},
        SESSION_COOKIE_NAME=f"whisperlink_{EDITION}_session",
        PERMANENT_SESSION_LIFETIME=60 * 60 * 12,
        MAX_CONTENT_LENGTH=1024 * 64,
    )
    if config:
        app.config.update(config)
    prefix = normalize_root(os.environ.get("APPLICATION_ROOT", DEFAULT_PREFIX))
    if prefix:
        app.config["SESSION_COOKIE_PATH"] = prefix + "/"
        app.wsgi_app = PrefixMiddleware(app.wsgi_app, prefix)

    # ---------------- database ----------------
    def get_db() -> sqlite3.Connection:
        if "db" not in g:
            g.db = sqlite3.connect(app.config["DATABASE"])
            g.db.row_factory = sqlite3.Row
        return g.db

    @app.teardown_appcontext
    def close_db(_exc):
        db = g.pop("db", None)
        if db is not None:
            db.close()

    def init_db():
        db = sqlite3.connect(app.config["DATABASE"])
        db.executescript(SCHEMA)
        now = int(time.time())
        # Deterministic demo accounts (documented in the README). Admin password overridable via env.
        seeds = [
            ("admin", os.environ.get("CHIRP_ADMIN_PASSWORD", "admin-change-me"), 1),
            ("demo", "demo-change-me", 0),
            ("alice", "alice-change-me", 0),
            ("bob", "bob-change-me", 0),
        ]
        for username, pw, is_admin in seeds:
            row = db.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
            if row is None:
                try:
                    db.execute(
                        "INSERT INTO users(username,pw_hash,is_admin,must_change,created_at) VALUES(?,?,?,0,?)",
                        (username, generate_password_hash(pw), is_admin, now),
                    )
                except sqlite3.IntegrityError:
                    pass  # concurrent gunicorn worker already inserted
        db.commit()
        db.close()

    init_db()
    app.get_db = get_db  # type: ignore[attr-defined]

    # ---------------- security helpers ----------------
    failures: dict[str, list[float]] = {}

    def throttled(key: str) -> bool:
        now = time.time()
        hits = [t for t in failures.get(key, []) if now - t < 300]
        failures[key] = hits
        return len(hits) >= 8

    def csrf_token() -> str:
        if "_csrf" not in session:
            session["_csrf"] = secrets.token_urlsafe(24)
        return session["_csrf"]

    @app.before_request
    def csrf_protect():
        if request.method == "POST":
            tok = request.form.get("_csrf") or request.headers.get("X-CSRF-Token")
            if not tok or not secrets.compare_digest(tok, session.get("_csrf", "")):
                abort(400, "CSRF token missing or invalid")

    @app.after_request
    def security_headers(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        resp.headers.setdefault("Permissions-Policy", "microphone=(self), camera=()")
        resp.headers.setdefault("Content-Security-Policy",
                                "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
                                "style-src 'self'; script-src 'self'; worker-src 'self' blob:; connect-src 'self'; "
                                "frame-ancestors 'self'; base-uri 'self'; form-action 'self'")
        return resp

    def current_user():
        uid = session.get("uid")
        if uid is None:
            return None
        if "user" not in g:
            g.user = get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        return g.user

    @app.context_processor
    def inject():
        return {"csrf_token": csrf_token, "user": current_user(), "APP_NAME": APP_NAME, "EDITION": EDITION,
                "allow_registration": app.config["ALLOW_REGISTRATION"]}

    def login_required(view):
        @wraps(view)
        def wrapped(*a, **kw):
            u = current_user()
            if u is None:
                return redirect(url_for("login", next=request.full_path if request.method == "GET" else None))
            if u["must_change"] and request.endpoint not in {"account", "logout"}:
                flash("Please set a new password before continuing.", "warn")
                return redirect(url_for("account"))
            return view(*a, **kw)
        return wrapped

    def admin_required(view):
        @wraps(view)
        @login_required
        def wrapped(*a, **kw):
            if not current_user()["is_admin"]:
                abort(403)
            return view(*a, **kw)
        return wrapped

    def valid_password(pw: str) -> str | None:
        if len(pw) < 10:
            return "Password must be at least 10 characters."
        if pw.lower().startswith("change-me"):
            return "Pick a password that is not a change-me default."
        return None

    def safe_next(target: str | None) -> str:
        if target and target.startswith("/") and not target.startswith("//"):
            return request.script_root + target if not target.startswith(request.script_root + "/") else target
        return url_for("dashboard")

    # ---------------- routes ----------------
    @app.get("/")
    def index():
        return redirect(url_for("dashboard") if current_user() else url_for("login"))

    @app.route("/login", methods=["GET", "POST"])
    def login():
        if request.method == "POST":
            ip = request.headers.get("X-Real-IP", request.remote_addr or "?")
            username = (request.form.get("username") or "").strip()
            if throttled(ip) or throttled("u:" + username.lower()):
                flash("Too many failed attempts. Try again in a few minutes.", "error")
                return render_template("login.html"), 429
            row = get_db().execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
            if row and check_password_hash(row["pw_hash"], request.form.get("password") or ""):
                session.clear()
                session.permanent = True
                session["uid"] = row["id"]
                get_db().execute("UPDATE users SET last_login=? WHERE id=?", (int(time.time()), row["id"]))
                get_db().commit()
                return redirect(safe_next(request.args.get("next")))
            failures.setdefault(ip, []).append(time.time())
            failures.setdefault("u:" + username.lower(), []).append(time.time())
            flash("Invalid username or password.", "error")
        return render_template("login.html")

    @app.route("/register", methods=["GET", "POST"])
    def register():
        if not app.config["ALLOW_REGISTRATION"]:
            flash("Registration is disabled. Ask an administrator for an account.", "warn")
            return redirect(url_for("login"))
        if request.method == "POST":
            username = (request.form.get("username") or "").strip()
            pw, pw2 = request.form.get("password") or "", request.form.get("password2") or ""
            err = None
            if not (3 <= len(username) <= 32) or not all(c.isalnum() or c in "._-" for c in username):
                err = "Username: 3–32 characters, letters, digits, . _ -"
            elif pw != pw2:
                err = "Passwords do not match."
            else:
                err = valid_password(pw)
            if not err:
                try:
                    db = get_db()
                    cur = db.execute("INSERT INTO users(username,pw_hash,created_at) VALUES(?,?,?)",
                                     (username, generate_password_hash(pw), int(time.time())))
                    db.commit()
                    session.clear()
                    session["uid"] = cur.lastrowid
                    flash("Welcome aboard! Your account is ready.", "ok")
                    return redirect(url_for("dashboard"))
                except sqlite3.IntegrityError:
                    err = "That username is taken."
            flash(err, "error")
        return render_template("register.html")

    @app.post("/logout")
    def logout():
        session.clear()
        flash("Signed out.", "ok")
        return redirect(url_for("login"))

    @app.route("/account", methods=["GET", "POST"])
    @login_required
    def account():
        u = current_user()
        if request.method == "POST":
            cur, new, new2 = (request.form.get(k) or "" for k in ("current", "new", "new2"))
            err = None
            if not check_password_hash(u["pw_hash"], cur):
                err = "Current password is wrong."
            elif new != new2:
                err = "New passwords do not match."
            else:
                err = valid_password(new)
            if err:
                flash(err, "error")
            else:
                get_db().execute("UPDATE users SET pw_hash=?, must_change=0 WHERE id=?", (generate_password_hash(new), u["id"]))
                get_db().commit()
                flash("Password updated.", "ok")
                return redirect(url_for("dashboard"))
        return render_template("account.html")

    @app.get("/dashboard")
    @login_required
    def dashboard():
        return render_template("dashboard.html")

    @app.get("/room")
    @login_required
    def room():
        return render_template("room.html")

    @app.get("/protocol")
    @login_required
    def protocol():
        return render_template("protocol.html")

    @app.route("/admin/users", methods=["GET", "POST"])
    @admin_required
    def admin_users():
        db = get_db()
        if request.method == "POST":
            action = request.form.get("action")
            if action == "create":
                username = (request.form.get("username") or "").strip()
                pw = request.form.get("password") or secrets.token_urlsafe(12)
                try:
                    db.execute("INSERT INTO users(username,pw_hash,is_admin,must_change,created_at) VALUES(?,?,?,1,?)",
                               (username, generate_password_hash(pw), 1 if request.form.get("is_admin") else 0, int(time.time())))
                    db.commit()
                    flash(f"Created {username}. Temporary password: {pw} (must change at first login)", "ok")
                except sqlite3.IntegrityError:
                    flash("Username exists.", "error")
            elif action == "delete":
                uid = int(request.form.get("uid", "0"))
                if uid == current_user()["id"]:
                    flash("You cannot delete yourself.", "error")
                else:
                    db.execute("DELETE FROM users WHERE id=?", (uid,))
                    db.commit()
                    flash("User deleted.", "ok")
            return redirect(url_for("admin_users"))
        users = db.execute("SELECT id,username,is_admin,must_change,created_at,last_login FROM users ORDER BY id").fetchall()
        return render_template("admin.html", users=users)

    @app.get("/healthz")
    def healthz():
        return {"ok": True, "edition": EDITION}

    @app.template_filter("ts")
    def ts(v):
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(v)) if v else "—"

    @app.cli.command("create-user")
    def create_user_cmd():  # pragma: no cover - CLI
        """Create a user: flask --app wsgi create-user (reads USERNAME, PASSWORD, ADMIN env)."""
        import getpass
        username = os.environ.get("USERNAME_NEW") or input("username: ")
        pw = os.environ.get("PASSWORD_NEW") or getpass.getpass("password: ")
        admin = os.environ.get("ADMIN_NEW", "0") == "1"
        db = sqlite3.connect(app.config["DATABASE"])
        db.execute("INSERT OR REPLACE INTO users(id,username,pw_hash,is_admin,must_change,created_at) VALUES("
                   "(SELECT id FROM users WHERE username=?),?,?,?,0,?)",
                   (username, username, generate_password_hash(pw), 1 if admin else 0, int(time.time())))
        db.commit()
        print(f"user {username} saved (admin={admin})")

    return app
