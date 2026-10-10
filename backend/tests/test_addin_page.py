"""The Word add-in pages: which files the backend serves and which it does not.

The pages live under /addin/, mirroring the repo layout:
/addin/word-addin/...            the add-in's own pages
/addin/browser-extension/lib/... the rules shared with the browser extension
"""

import re

import httpx
import pytest

from app.main import ADDIN_TYPES, find_addin_files


def nothing(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"unexpected request to {request.url}")


@pytest.fixture
def client(make_client):
    # As deployed: the service sits under /api and the reverse proxy has already stripped /api.
    return make_client(nothing, root_path="/api")


def test_the_page_and_its_scripts_are_served(client):
    page = client.get("/addin/word-addin/spike.html")
    assert page.status_code == 200
    assert page.headers["content-type"].startswith("text/html")
    # After a backend upgrade the browser inside Word must not keep old files.
    assert page.headers["cache-control"] == "no-cache"

    assert client.get("/addin/word-addin/taskpane.html").status_code == 200  # the real task pane

    for path in ("word-addin/taskpane.js", "word-addin/spike.js", "word-addin/lib/pages.js", "word-addin/lib/tracker.js", "browser-extension/lib/dictionary.js"):
        script = client.get(f"/addin/{path}")
        assert script.status_code == 200, path
        # Must be declared a script, or the browser refuses to run it as a module and the page stays blank.
        assert script.headers["content-type"].startswith("text/javascript"), path

    assert client.get("/addin/word-addin/addin.css").headers["content-type"].startswith("text/css")
    icon = client.get("/addin/word-addin/icons/icon32.png")
    assert icon.headers["content-type"] == "image/png"
    assert icon.content.startswith(b"\x89PNG")


def test_only_listed_files_are_served(client):
    refused = [
        "word-addin/tests/pages.test.js",  # tests
        "word-addin/package.json",  # not part of the pages
        "word-addin/manifest.template.xml",  # a template; the real manifest is generated, and read by Word, not a browser
        "browser-extension/background.js",  # only lib is shared with the extension
        "browser-extension/manifest.json",
        "word-addin/../backend/app/config.py",
        "../backend/app/config.py",
        "word-addin/%2e%2e/backend/app/config.py",
        "word-addin/nothing.html",
        "",
    ]
    for path in refused:
        assert client.get(f"/addin/{path}").status_code == 404, path


def test_every_file_a_page_refers_to_is_served_too():
    # Every script and stylesheet a page references, and every script a script imports, must
    # be in the list. One missing file means the page fails to open in Word, with no reason given.
    files = find_addin_files()
    assert "word-addin/spike.html" in files
    checked = 0
    for name, path in files.items():
        if path.suffix == ".js":
            pattern = r'^\s*(?:import|export)\b[^;]*?\bfrom\s+["\'](\.{1,2}/[^"\']+)["\']'
        elif path.suffix == ".html":
            pattern = r'\b(?:src|href)\s*=\s*"([^"#:]+)"'  # a colon means an external URL (office.js): skipped
        else:
            continue
        folder = name.rsplit("/", 1)[0]
        for wanted in re.findall(pattern, path.read_text(encoding="utf-8"), flags=re.MULTILINE):
            parts: list[str] = []
            for part in f"{folder}/{wanted}".split("/"):
                if part == "..":
                    parts.pop()
                elif part != ".":
                    parts.append(part)
            assert "/".join(parts) in files, f"{name} refers to {wanted}, which is not served"
            checked += 1
    assert checked >= 3  # something was really checked: spike.html references a stylesheet and a script, spike.js imports pages.js


def test_in_the_image_the_packed_folder_is_used(tmp_path):
    # In the image the files are already selected into app/static/addin/. If that folder exists, only it is used.
    packed = tmp_path / "addin"
    (packed / "word-addin" / "lib").mkdir(parents=True)
    (packed / "word-addin" / "spike.html").write_text("<html></html>", encoding="utf-8")
    (packed / "word-addin" / "lib" / "pages.js").write_text("export {};", encoding="utf-8")
    (packed / "word-addin" / "notes.txt").write_text("not a web file", encoding="utf-8")
    files = find_addin_files(packed=packed, repo=tmp_path / "no-repo-here")
    assert sorted(files) == ["word-addin/lib/pages.js", "word-addin/spike.html"]


def test_without_any_addin_files_the_service_still_starts(tmp_path, make_client):
    assert find_addin_files(packed=tmp_path / "missing", repo=tmp_path / "also-missing") == {}
    assert set(ADDIN_TYPES) == {".html", ".js", ".css", ".png"}
