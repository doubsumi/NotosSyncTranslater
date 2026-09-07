"""Development / container entry point.

Usage:
    python run.py                     # host: 0.0.0.0 port: 5000
    python run.py --port 8000 --no-reload

Prefers Waitress (production-grade, threaded) when installed and falls back
to the Flask dev server otherwise.
"""
from __future__ import annotations

import argparse
import atexit

from app import create_app
from app.config import Config


def main() -> None:
    parser = argparse.ArgumentParser(description="Notos Sync Translator backend")
    parser.add_argument("--host", default=None, help="bind host")
    parser.add_argument("--port", type=int, default=None, help="bind port")
    parser.add_argument("--no-reload", action="store_true", help="disable auto-reload")
    args = parser.parse_args()

    cfg = Config()
    host = args.host or cfg.host
    port = args.port or cfg.port
    app = create_app(cfg)

    if cfg.static_dir:
        print(f"  Serving SPA from:      {cfg.static_dir}")
    print(f"  Listening on:          http://{host}:{port}")

    atexit.register(_shutdown, app)

    try:
        from waitress import serve  # type: ignore[import-not-found]

        print("  Server:                waitress (threaded)")
        serve(app, host=host, port=port, threads=8)
    except ImportError:
        print("  Server:                flask dev (threaded=True)  [install waitress for prod]")
        app.run(host=host, port=port, threaded=True, debug=cfg.debug and not args.no_reload)


def _shutdown(app) -> None:  # noqa: ANN001
    engine = app.extensions.get("nst_engine")
    cache = app.extensions.get("nst_cache")
    if engine is not None:
        engine.close()
    if cache is not None:
        cache.close()


if __name__ == "__main__":
    main()
