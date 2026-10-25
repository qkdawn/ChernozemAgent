import { spawn } from "node:child_process";
import { resolve } from "node:path";

export function runPythonTool<T>(scriptName: string, input: unknown, pythonExecutable = process.env.PYTHON_EXECUTABLE ?? "python"): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const script = resolve(import.meta.dirname, "../scripts", scriptName);
    const child = spawn(pythonExecutable, [script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, PYTHONUTF8: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `Python 处理进程退出码 ${code ?? "unknown"}。`));
      try { resolvePromise(JSON.parse(stdout) as T); } catch { reject(new Error(`Python 处理返回了无效结果：${stdout.slice(0, 200)}`)); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
