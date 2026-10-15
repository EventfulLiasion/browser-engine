@echo off
setlocal
cd /d "%~dp0"
where dotnet >nul 2>nul
if errorlevel 1 (
  echo The .NET 10 SDK is required to start Titan.
  echo Install it from https://dotnet.microsoft.com/download/dotnet/10.0
  pause
  exit /b 1
)
dotnet run --project "Titan.Desktop\Titan.Desktop.csproj"
if errorlevel 1 pause
