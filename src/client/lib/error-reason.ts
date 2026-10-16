/** 把常见的模型/网络错误翻成一句白话；认不出来就返回 undefined，让界面显示原始首行。 */
export function plainErrorReason(message: string, code?: string): string | undefined {
  const text = `${code ?? ""} ${message}`.toLowerCase();
  if (code === "PI_COMPACTION_FAILED") return "压缩上下文没有生成可用摘要。";
  if (code === "RUN_INTERRUPTED") return "Jarvis 服务在这一轮结束前重启或异常退出了，回答可能没写完。点「继续」让它接着做。";
  if (/context[_ ]length|context window|maximum context|too many tokens|prompt is too long/.test(text)) return "对话太长，超出了模型能读的上下文。可以先压缩上下文再继续。";
  if (/\b401\b|unauthori[sz]ed|invalid api key|authentication/.test(text)) return "模型服务拒绝了凭据（401），请检查 API Key。";
  if (/\b403\b|forbidden|permission denied/.test(text)) return "模型服务拒绝了这次请求（403），可能是权限或额度问题。";
  if (/\b429\b|rate.?limit|too many requests|quota/.test(text)) return "请求太频繁或额度用完（429），稍等一会儿再试。";
  if (/\b5\d\d\b|overloaded|bad gateway|service unavailable|internal server error/.test(text)) return "模型服务暂时出错（5xx），通常稍后重试就好。";
  if (/econnreset|etimedout|enotfound|econnrefused|network|fetch failed|socket hang up|timed? ?out/.test(text)) return "网络连接出了问题，没能连上模型服务。";
  if (/abort|cancell?ed/.test(text)) return "请求被中止了。";
  return undefined;
}
