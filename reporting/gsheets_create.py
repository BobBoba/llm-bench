"""Create the 'LLM Benchmark' spreadsheet (3 tabs), share it back to the owner, and
record its id in gsheets-sheet-id.txt for the pusher. Run once; safe to re-run only if
you delete/rename the previous one (this always creates a NEW spreadsheet).

    .venv-gsheets/bin/python gsheets_create.py
"""
import os
from googleapiclient.discovery import build
from gsheets_common import credentials, OWNER_EMAIL

HERE = os.path.dirname(os.path.abspath(__file__))
creds = credentials()
sheets = build("sheets", "v4", credentials=creds)
drive = build("drive", "v3", credentials=creds)

body = {
    "properties": {"title": "LLM Benchmark"},
    "sheets": [
        {"properties": {"title": "RUST", "index": 0}},
        {"properties": {"title": "humanitarian", "index": 1}},
        {"properties": {"title": "TypeScript", "index": 2}},
    ],
}
ss = sheets.spreadsheets().create(body=body, fields="spreadsheetId,spreadsheetUrl").execute()
sid, url = ss["spreadsheetId"], ss["spreadsheetUrl"]

# share back to the human owner (service account owns it; owner gets Editor)
drive.permissions().create(
    fileId=sid, sendNotificationEmail=False,
    body={"type": "user", "role": "writer", "emailAddress": OWNER_EMAIL},
).execute()

with open(os.path.join(HERE, "gsheets-sheet-id.txt"), "w") as f:
    f.write(sid + "\n")

print("spreadsheetId:", sid)
print("url:", url)
print("shared with:", OWNER_EMAIL, "(Editor)")
