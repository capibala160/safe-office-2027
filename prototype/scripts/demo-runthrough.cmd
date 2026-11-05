@echo off
cd /d "%~dp0.."
node scripts\demo-runthrough.cjs --port %1 --pause
