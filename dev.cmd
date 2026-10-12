@echo off
chcp 65001 >nul
REM ============================================================
REM DSH Plugin Review - minimal slice - local dev launcher
REM
REM   dev.cmd            migrate + self-check + start Web (default)
REM   dev.cmd web        start Web only
REM   dev.cmd worker     start worker only
REM   dev.cmd migrate    migrate + self-check only
REM   dev.cmd test       typecheck + tests
REM   dev.cmd accept     HTTP acceptance: read/write/upload (Web must be running)
REM   dev.cmd demo       seed a demo review (Web must be running)
REM   dev.cmd reset      drop .data and rebuild (local dev only)
REM
REM To let submissions auto-publish locally, set BOTH shells before starting:
REM   set DSH_REVIEW_CONTENT_SCREEN=basic
REM Leave it empty for the safe default (stop at manual_review).
REM
REM First time:  npm install
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "MODE=%~1"
if "%MODE%"=="" set "MODE=dev"

if not exist "node_modules" (
  echo [ERROR] node_modules not found. Run:  npm install
  exit /b 1
)

if /i "%MODE%"=="reset"   goto reset
if /i "%MODE%"=="migrate" goto migrate
if /i "%MODE%"=="test"    goto test
if /i "%MODE%"=="accept"  goto accept
if /i "%MODE%"=="demo"    goto demo
if /i "%MODE%"=="web"     goto web
if /i "%MODE%"=="worker"  goto worker
if /i "%MODE%"=="dev"     goto dev

echo [ERROR] unknown mode: %MODE%
echo usage: dev.cmd [dev ^| web ^| worker ^| migrate ^| test ^| accept ^| demo ^| reset]
exit /b 1

:reset
echo [1/2] removing local database directory .data ...
if exist ".data" rd /s /q ".data"
echo [2/2] migrating and self-checking ...
call npm run db:migrate
if errorlevel 1 exit /b 1
call npm run db:check
if errorlevel 1 exit /b 1
echo.
echo done: local database rebuilt.
goto :eof

:migrate
echo [1/2] applying migrations ...
call npm run db:migrate
if errorlevel 1 exit /b 1
echo.
echo [2/2] self-check ...
call npm run db:check
if errorlevel 1 exit /b 1
goto :eof

:test
echo [1/2] typecheck ...
call npx tsc --noEmit
if errorlevel 1 exit /b 1
echo.
echo [2/2] tests ...
call npm test
if errorlevel 1 exit /b 1
goto :eof

:accept
echo HTTP acceptance (requires Web running on port 3100) ...
echo --- read path ---
call node scripts\acceptance-http.mjs
if errorlevel 1 exit /b 1
echo.
echo --- write path ---
call npx tsx scripts\acceptance-http-write.mjs
if errorlevel 1 exit /b 1
echo.
echo --- upload path ---
call npx tsx scripts\acceptance-upload.mjs
if errorlevel 1 exit /b 1
echo.
echo --- end-to-end chain (real worker process) ---
call npx tsx scripts\acceptance-e2e-chain.mjs
if errorlevel 1 exit /b 1
goto :eof

:demo
REM 演示要能走完「提交 -> 自动发布」，所以这里显式打开本地基础筛查。
REM 只有 basic 才可能自动 approved；默认留空会停在 manual_review（这是刻意的保守默认）。
if "%DSH_REVIEW_CONTENT_SCREEN%"=="" set "DSH_REVIEW_CONTENT_SCREEN=basic"
echo seeding a demo review (requires Web running on port 3100) ...
echo   DSH_REVIEW_CONTENT_SCREEN=%DSH_REVIEW_CONTENT_SCREEN%
echo   NOTE: Web process must have the same DSH_REVIEW_CONTENT_SCREEN value,
echo         otherwise submissions stop at manual_review instead of publishing.
call npx tsx scripts\seed-demo.mjs
goto :eof

:dev
call :prepare
if errorlevel 1 exit /b 1
echo.
echo ============================================================
echo   Web starting:  http://127.0.0.1:3100
echo   stop with Ctrl+C
echo   (for worker, open another window:  dev.cmd worker )
echo ============================================================
echo.
call npm run dev
goto :eof

:web
call npm run dev
goto :eof

:worker
echo starting worker (independent task process) ...
call npm run worker
goto :eof

:prepare
if not exist ".data" (
  echo [1/3] first run: creating .data ...
  mkdir ".data" 2>nul
) else (
  echo [1/3] .data exists, skipping
)
echo [2/3] applying migrations ...
call npm run db:migrate
if errorlevel 1 exit /b 1
echo.
echo [3/3] self-check ...
call npm run db:check
if errorlevel 1 exit /b 1
echo.
exit /b 0
