import type { Request, Response } from 'express';
import { UserModel } from '../models/User.model.js';
import type { ObjectIdParams } from '../types/common.types.js';
import type { CreateUserBody } from '../types/user.types.js';

export async function listUsers(_req: Request, res: Response) {
  try {
    const users = await UserModel.find();
    return res.status(200).json(users);
  } catch (_err) {
    return res.status(500).json({ message: 'server error' });
  }
}

export async function getUserById(req: Request, res: Response) {
  try {
    const { id } = req.params as ObjectIdParams;
    const user = await UserModel.findById(id);

    if (!user) {
      return res.status(404).json({ message: 'user not found' });
    }

    return res.status(200).json(user);
  } catch (_err) {
    return res.status(500).json({ message: 'server error' });
  }
}

export async function createUser(req: Request, res: Response) {
  try {
    const { email, name } = req.body as CreateUserBody;
    const created = await UserModel.create({ email, name, posts: [] });
    return res.status(201).json(created);
  } catch (err: any) {
    // duplicate email
    if (err?.code === 11000) {
      return res.status(409).json({ message: 'email already exists' });
    }
    console.log(err);
    return res.status(500).json({ message: 'server error' });
  }
}
