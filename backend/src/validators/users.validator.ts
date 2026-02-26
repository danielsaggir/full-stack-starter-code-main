import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import type { ObjectIdParams } from '../types/common.types.js';
import type { CreateUserBody } from '../types/user.types.js';

export function validateUserId(req: Request, res: Response, next: NextFunction) {
  const { id } = req.params as Partial<ObjectIdParams>;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ message: 'invalid user id' });
  }

  return next();
}

export function validateCreateUser(req: Request, res: Response, next: NextFunction) {
  if (!req.body) return res.status(400).json({ message: 'body is required' });

  const { email, name } = req.body as Partial<CreateUserBody>;

  if (!email || !name) {
    return res.status(400).json({ message: 'email and name are required' });
  }
  if (typeof email !== 'string' || typeof name !== 'string') {
    return res.status(400).json({ message: 'email and name must be strings' });
  }
  if (!email.trim() || !name.trim()) {
    return res.status(400).json({ message: 'email and name cannot be empty' });
  }

  return next();
}
