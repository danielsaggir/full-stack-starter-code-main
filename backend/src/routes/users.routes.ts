import { Router } from 'express';
import { createUser, getUserById, listUsers } from '../controllers/users.controller.js';
import { validateCreateUser, validateUserId } from '../validators/users.validator.js';

export const usersRouter = Router();

usersRouter.get('/', listUsers);
usersRouter.get('/:id', validateUserId, getUserById);
usersRouter.post('/', validateCreateUser, createUser);
