// Additional guard only: explicit source selection and packet review remain necessary.
export const sensitiveText =
  /(?:[A-Za-z]:[\\/]|\\\\[^\s\\]+\\|\/(?:home|Users|etc|var|opt|tmp|mnt)\/|(?:\.local|\.codex|\.ai-rules)[\\/]|\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{15,}|BEGIN [A-Z ]*PRIVATE KEY|\b(?:password|api[_ -]?key|token)\s*[:=]\s*\S+)/i;
