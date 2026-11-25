// Everything that comes from a feed is UNTRUSTED DATA.
// We strip markup, hidden characters and obvious prompt-injection text
// before any of it gets near the LLM.

const INJECTION_PATTERNS = [
  /ignore (all |any )?(previous|prior|above) (instructions|prompts?)/i,
  /disregard (all |any )?(previous|prior|above)/i,
  /you are now/i,
  /system prompt/i,
  /new instructions?:/i,
  /act as (an?|the) /i,
  /do not (tell|inform) the user/i,
  /(publish|post) (this|the following) (immediately|now|verbatim)/i,
  /api[_ -]?key/i,
  /<\s*\/?\s*(system|assistant|instructions?)\s*>/i,
];

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };

export function cleanText(value, maxLength = 600) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  text = text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<(script|style|iframe|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m])
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\p{Cf}/gu, '') // invisible format chars: zero-width spaces, bidi overrides, BOM
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? text.slice(0, maxLength) + '…' : text;
}

export function findInjection(text) {
  const hit = INJECTION_PATTERNS.find((pattern) => pattern.test(text));
  return hit ? hit.source : null;
}

export function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}
