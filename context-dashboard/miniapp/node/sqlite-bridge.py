# Read-only SQLite bridge for the context dashboard Mini App.
#
# Used only when the Mini App Node runtime cannot load `node:sqlite`. The Node side spawns this
# script with an argument array (no shell) and writes one JSON request to stdin.
#
# Request : {"db": "<path>", "sql": "<select ...>", "params": [...], "limit": 20000}
# Response: {"ok": true,  "columns": ["..."], "rows": [[...]]}
#           {"ok": false, "error": "<TypeError: message>"}
#
# The connection is opened read-only through the SQLite URI interface, so this script can never
# modify the running application's database. Output stays ASCII because json.dump escapes
# non-ASCII text by default, which keeps Windows console code pages out of the picture.

import json
import sqlite3
import sys

DEFAULT_LIMIT = 20000


def main():
    try:
        request = json.load(sys.stdin)
        db_path = request["db"]
        sql = request["sql"]
        params = request.get("params") or []
        limit = int(request.get("limit") or DEFAULT_LIMIT)
    except Exception as exc:  # noqa: BLE001 - report every request-shape failure the same way
        json.dump({"ok": False, "error": "request: %s: %s" % (type(exc).__name__, exc)}, sys.stdout)
        sys.stdout.write("\n")
        return

    try:
        uri = "file:%s?mode=ro" % db_path.replace("?", "%3f").replace("#", "%23")
        connection = sqlite3.connect(uri, uri=True, timeout=10)
        try:
            cursor = connection.execute(sql, params)
            rows = cursor.fetchmany(limit)
            columns = [description[0] for description in cursor.description] if cursor.description else []
            payload = [list(row) for row in rows]
        finally:
            connection.close()
        json.dump({"ok": True, "columns": columns, "rows": payload}, sys.stdout)
    except Exception as exc:  # noqa: BLE001 - surface the failing reason instead of crashing
        json.dump({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}, sys.stdout)

    sys.stdout.write("\n")


main()
