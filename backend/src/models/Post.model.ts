import { Schema, model, Types, type HydratedDocument } from 'mongoose';

type Post = {
  createdBy: Types.ObjectId;
  title: string;
  content: string;
};

export type PostType = HydratedDocument<Post>;

const PostSchema = new Schema<Post>(
  {
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true },
    content: { type: String, required: true },
  },
  { timestamps: true },
);

export const PostModel = model<Post>('Post', PostSchema);
