import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import type { CreatePostBody, UpdatePostBody } from '../types/posts.types.js';
import type { ObjectIdParams } from '../types/common.types.js';

export function validateCreatePost(req: Request, res: Response, next: NextFunction) {
  if (!req.body) return res.status(400).json({ message: 'body is required' });
  const { createdBy, title, content } = req.body as Partial<CreatePostBody>;

  if (!createdBy || !title || !content) {
    return res.status(400).json({ message: 'createdBy, title, content are required' });
  }
  if (!mongoose.isValidObjectId(createdBy)) {
    return res.status(400).json({ message: 'createdBy is not a valid ObjectId' });
  }

  return next();
}

export function validatePostId(req: Request, res: Response, next: NextFunction) {
  const { id } = req.params as Partial<ObjectIdParams>;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: 'invalid id' });
  return next();
}

export function validateUpdatePost(req: Request, res: Response, next: NextFunction) {
  if (!req.body) return res.status(400).json({ message: 'body is required' });
  const { title, content } = req.body as Partial<UpdatePostBody>;
  if (!title && !content) {
    return res.status(400).json({ message: 'provide title and/or content' });
  }

  return next();
}
