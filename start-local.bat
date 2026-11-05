@echo off
cd /d "%~dp0"
if not exist .env (
  copy .env.example .env >nul
  echo Open the .env file and set AI_API_KEY, ADMIN_EMAIL, and ADMIN_PASSWORD.
  notepad .env
)
if not exist node_modules\better-sqlite3 (
  echo Installing required packages...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm start
pause
