import { Router } from 'express';
import {
  createPost,
  deletePost,
  getPostById,
  listPosts,
  updatePost,
} from '../controllers/posts.controller.js';
import {
  validateCreatePost,
  validatePostId,
  validateUpdatePost,
} from '../validators/posts.validator.js';

export const postsRouter = Router();

postsRouter.post('/', validateCreatePost, createPost);
postsRouter.get('/', listPosts);
postsRouter.get('/:id', validatePostId, getPostById);
postsRouter.patch('/:id', validatePostId, validateUpdatePost, updatePost);
postsRouter.delete('/:id', validatePostId, deletePost);
