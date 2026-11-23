@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
start "" http://localhost:5178
node --env-file-if-exists=.env server.js
pause
