# CodeGuard

CodeGuard analyzes Git commits, maps their dependency impact, recommends targeted
regression tests, and records test and risk results in SQLite.

## Run locally

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
py -3 -m pip install -r requirements.txt
npm install
npm run dev
```

Open `http://localhost:3000`. By default, CodeGuard analyzes this repository.
Set `PYTHON_EXECUTABLE` when the required Python launcher is not available as
`py` on Windows or `python3` on macOS/Linux.

## Verify

```powershell
npm run lint
npm run build
npm run test:python
```
