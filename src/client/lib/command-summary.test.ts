import { describe, expect, it } from "vitest";
import { commandLabel, commandSummary } from "./command-summary";

/** 用例全部取自本机 23,354 条真实 bash / powershell 工具调用。 */
describe("commandSummary", () => {
  it("drops a leading assignment and cd, and shows the command that runs", () => {
    const command = 'D="/c/Users/fszax/AppData/Local/Temp/h5-delivery/dist-ui/build/h5"\ncd "$D" && tar czf /c/Users/fszax/AppData/Local/Temp/deploy/h5-ui.tar.gz . && ls -lh /c/Users/fszax/AppData/Local/Temp/deploy/h5-ui.tar.gz | awk \'{print "包大小", $5}\'';
    expect(commandSummary(command).text).toBe('tar czf …/Temp/deploy/h5-ui.tar.gz . → ls -lh …/Temp/deploy/h5-ui.tar.gz | awk \'{print "包大小", $5}\'');
  });

  it("keeps the real script call after env prefixes and drops output redirection", () => {
    const command = 'MSYS_NO_PATHCONV=1 node "C:/Users/fszax/.pi/agent/skills/panel1/scripts/client.mjs" files upload --site shizong1p --file "C:/Users/fszax/AppData/Local/Temp/deploy/h5-ui.tar.gz" --path /opt/1panel/www/sites/pengzong-preview/index >/dev/null 2>&1 && echo \'上传完成\'';
    expect(commandSummary(command).text).toBe('node "…/panel1/scripts/client.mjs" files upload --site shizong1p --file "…/Temp/deploy/h5-ui.tar.gz" --path /opt/1panel/www/sites/pengzong-preview…');
  });

  it("resolves variables an earlier statement set", () => {
    const command = 'PW="C:/Users/fszax/.pi/agent/npm/node_modules/pi-playwright/node_modules/.bin/playwright-cli.cmd"\n"$PW" -s=qa-admin snapshot';
    expect(commandSummary(command).text).toBe("playwright-cli -s=qa-admin snapshot");
  });

  it("strips a quoted absolute path used as the executable and PowerShell's call operator", () => {
    expect(commandSummary('"C:/Users/fszax/.pi/agent/npm/node_modules/pi-playwright/node_modules/.bin/playwright-cli.cmd" -s=hf-staff click e669').text).toBe("playwright-cli -s=hf-staff click e669");
    expect(commandSummary(`& 'D:/Program Files/Bandizip/bz.exe' c -y -r 'D:/projects/compass/.tmp-deploy/compass.zip'`).text).toBe("bz c -y -r 'D:/projects/compass/.tmp-deploy/compass.zip'");
  });

  it("keeps a heredoc marker but never its body", () => {
    expect(commandLabel("python - << 'PY'\nimport json\nprint(json.dumps({'ok': True}))\nPY")).toBe("python - << 'PY'");
    expect(commandLabel("cat <<EOF\r\nhello\r\nEOF")).toBe("cat <<EOF");
  });

  it("collapses inline scripts behind -e / -c", () => {
    expect(commandLabel(`node -e "const x=require('fs').readFileSync('a.txt','utf8'); console.log(x.length)"`)).toBe('node -e "…"');
    expect(commandLabel(`python -c "import secrets;print(secrets.token_hex(32))"`)).toBe('python -c "…"');
  });

  it("keeps the command inside a command substitution assignment", () => {
    expect(commandLabel("html=$(curl -sS https://example.com/)")).toBe("curl -sS https://example.com/");
    expect(commandLabel('TOKEN=$(python -c "import secrets;print(secrets.token_hex(32))")')).toBe('python -c "…"');
  });

  it("drops pure data assignments, including PowerShell ones", () => {
    expect(commandLabel('$out=\'C:\\Users\\fszax\\AppData\\Local\\Temp\\gao-research\'; New-Item -ItemType Directory -Force $out | Out-Null')).toBe("New-Item -ItemType Directory -Force …/Local/Temp/gao-research | Out-Null");
    expect(commandLabel("export PATH=\"$PATH:/usr/local/bin\"")).toBe("export PATH=\"$PATH:/usr/local/bin\"");
    expect(commandLabel("$ErrorActionPreference='Stop'")).toBe("$ErrorActionPreference='Stop'");
    expect(commandLabel('$env:MSYS_NO_PATHCONV = "1"; node scripts/client.mjs api list')).toBe("node scripts/client.mjs api list");
  });

  it("resolves a PowerShell variable used as the command", () => {
    const command = "$aapt='C:\\tools\\aapt2.exe'; $apk='D:\\build\\app.apk'; & $aapt dump badging $apk | Select-String 'package:'";
    expect(commandLabel(command)).toBe("aapt2 dump badging D:\\build\\app.apk | Select-String 'package:'");
  });

  it("keeps the command when a variable holds its result", () => {
    expect(commandLabel("$aapt=Get-ChildItem -Path C:\\Android -Recurse -Filter aapt.exe | Select-Object -First 1; $aapt | Select-Object FullName"))
      .toBe("Get-ChildItem -Path C:\\Android -Recurse -Filter aapt.exe | Select-Object -First 1");
  });

  it("never shows a PowerShell here-string body", () => {
    expect(commandLabel("$script=@'\nconst fs=require('fs');\nconsole.log(fs.existsSync('a'));\n'@; node -e $script")).toBe("node -e $script");
    expect(commandLabel("$rows = @'\nimport json\nprint(1)\n'@ | python -")).toBe("python -");
  });

  it("runs PowerShell blocks for their body and unwraps property access", () => {
    expect(commandLabel(`foreach ($route in @('/','/api/auth/session')) { try { $r = Invoke-WebRequest -Uri ('http://127.0.0.1:3000' + $route) -UseBasicParsing; } catch { } }`)).toBe("Invoke-WebRequest -Uri ('http://127.0.0.1:3000' + $route) -UseBasicParsing");
    expect(commandLabel("$html = (Invoke-WebRequest -Uri 'https://example.com/login' -SkipCertificateCheck).Content")).toBe("Invoke-WebRequest -Uri 'https://example.com/login' -SkipCertificateCheck");
  });

  it("folds loops down to the command they repeat", () => {
    expect(commandLabel("for p in 15173 15174 15175; do curl -s -o /dev/null -w \"%{http_code}\" \"http://127.0.0.1:$p/\"; done")).toBe('curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$p/"');
  });

  it("joins up to three steps and counts the rest", () => {
    const command = "cd /tmp && rm -rf old && mkdir -p new && unzip a.zip -d new && chmod -R 755 new && echo done";
    const summary = commandSummary(command);
    expect(summary.text).toBe("rm -rf old → mkdir -p new → unzip a.zip -d new → +1");
    expect(summary.hidden).toBe(1);
  });

  it("keeps a pipeline together and folds a shell comment-free one-liner", () => {
    expect(commandLabel('rg -n "万象" docs/*.md | head -20')).toBe('rg -n "万象" docs/*.md | head -20');
  });

  it("falls back to the raw first line when nothing can be parsed", () => {
    expect(commandSummary("").text).toBe("");
    expect(commandSummary("cd /tmp\nsleep 5").text).toBe("cd /tmp …");
    expect(commandLabel("")).toBe("命令");
  });

  it("never returns more than the row budget", () => {
    const command = Array.from({ length: 40 }, (_, index) => `node scripts/step-${String(index)}.mjs --flag`).join(" && ");
    expect(commandSummary(command).text.length).toBeLessThanOrEqual(150);
  });
});
