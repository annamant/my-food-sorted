import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface JwtPayload {
  userId: number;
  email: string;
}

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

export function authenticateToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) return res.sendStatus(401);

  jwt.verify(token, config.JWT_SECRET, (err, decoded) => {
    if (err) return res.sendStatus(401);
    req.user = decoded as JwtPayload;
    next();
  });
}

function founderEmailMatches(email: unknown, expected: string): boolean {
  const a = String(email ?? '').trim().toLowerCase();
  const b = String(expected ?? '').trim().toLowerCase();
  return Boolean(a) && Boolean(b) && a === b;
}

/**
 * Founder-only. Accepts a logged-in JWT for ADMIN_EMAIL.
 * Unknown callers get 404 so the route is not advertised.
 */
export function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const adminEmail = config.ADMIN_EMAIL;
  if (!adminEmail) {
    return res.status(404).json({ error: 'Not found' });
  }

  const authHeader = req.headers['authorization'];
  const bearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : '';

  if (bearer) {
    try {
      const decoded = jwt.verify(bearer, config.JWT_SECRET) as JwtPayload;
      if (founderEmailMatches(decoded?.email, adminEmail)) {
        req.user = decoded;
        return next();
      }
    } catch {
      // not a user session
    }
  }

  return res.status(404).json({ error: 'Not found' });
}
