@echo off
setlocal
set EXE=%TEMP%\jarvis-vs-buildtools\vs_BuildTools.exe
if not exist "%TEMP%\jarvis-vs-buildtools" mkdir "%TEMP%\jarvis-vs-buildtools"
if not exist "%EXE%" (
  echo Downloading VS Build Tools...
  curl -L "https://aka.ms/vs/17/release/vs_BuildTools.exe" -o "%EXE%"
)
echo Starting installer. Approve the UAC prompt.
"%EXE%" --wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended
echo Exit code %ERRORLEVEL%
pause
