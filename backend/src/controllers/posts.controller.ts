import type { Request, Response } from 'express';
import { PostModel } from '../models/Post.model.js';
import { UserModel } from '../models/User.model.js';
import type { CreatePostBody, UpdatePostBody } from '../types/posts.types.js';
import type { ObjectIdParams } from '../types/common.types.js';

// CREATE post + link into user.posts
export async function createPost(req: Request, res: Response) {
  try {
    const { createdBy, title, content } = req.body as CreatePostBody;

    const user = await UserModel.findById(createdBy);
    if (!user) return res.status(404).json({ message: 'user not found' });

    const post = await PostModel.create({ createdBy: user._id, title, content });

    // keep user.posts updated
    user.posts.push(post._id);
    await user.save();

    return res.status(201).json(post);
  } catch {
    return res.status(500).json({ message: 'server error' });
  }
}

// READ all posts (with createdBy populated)
export async function listPosts(_req: Request, res: Response) {
  try {
    const posts = await PostModel.find()
      .sort({ createdAt: -1 })
      .populate('createdBy', 'email name'); // only return those fields

    return res.json(posts);
  } catch {
    return res.status(500).json({ message: 'server error' });
  }
}

// READ one
export async function getPostById(req: Request, res: Response) {
  try {
    const { id } = req.params as ObjectIdParams;
    const post = await PostModel.findById(id).populate('createdBy', 'email name');
    if (!post) return res.status(404).json({ message: 'post not found' });

    return res.json(post);
  } catch {
    return res.status(500).json({ message: 'server error' });
  }
}

// UPDATE (title/content)
export async function updatePost(req: Request, res: Response) {
  try {
    const { id } = req.params as ObjectIdParams;
    const { title, content } = req.body as Partial<UpdatePostBody>;
    const updated = await PostModel.findByIdAndUpdate(
      id,
      { $set: { ...(title ? { title } : {}), ...(content ? { content } : {}) } },
      { new: true },
    );

    if (!updated) return res.status(404).json({ message: 'post not found' });
    return res.json(updated);
  } catch {
    return res.status(500).json({ message: 'server error' });
  }
}

// DELETE post + remove from user.posts
export async function deletePost(req: Request, res: Response) {
  try {
    const { id } = req.params as ObjectIdParams;
    const post = await PostModel.findById(id);
    if (!post) return res.status(404).json({ message: 'post not found' });

    await PostModel.deleteOne({ _id: post._id });

    await UserModel.updateOne({ _id: post.createdBy }, { $pull: { posts: post._id } });

    return res.status(204).send();
  } catch {
    return res.status(500).json({ message: 'server error' });
  }
}
