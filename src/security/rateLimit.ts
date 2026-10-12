import type { Request, Response, NextFunction } from "express";
import { log, safePath } from "../log.js";

// Fixed-window rate limiter kept in memory. Good for one app instance; with several instances
// behind a load balancer each enforces its own limit (put a shared limit at the proxy too).

export interface RateLimitOptions {
  name: string;
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
}

export function rateLimit(opts: RateLimitOptions) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = Date.now();
  const keyOf = opts.key ?? ((req: Request) => req.ip ?? "unknown");

  return function limiter(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    if (now - lastSweep > opts.windowMs) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      lastSweep = now;
    }
    const key = keyOf(req);
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    res.setHeader("RateLimit-Limit", String(opts.max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, opts.max - entry.count)));
    if (entry.count > opts.max) {
      const retry = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retry));
      if (entry.count === opts.max + 1) log.warn({ limiter: opts.name, path: safePath(req.originalUrl) }, "rate limit reached");
      return res.status(429).type("text/plain").send("Too many requests. Please wait a minute and try again.");
    }
    next();
  };
}
