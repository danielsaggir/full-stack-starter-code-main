import { Schema, model, Types, type HydratedDocument } from 'mongoose';

type UserProps = {
  email: string;
  name: string;
  posts: Types.ObjectId[];
};

export type UserDocument = HydratedDocument<UserProps>;

const UserSchema = new Schema<UserProps>(
  {
    email: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    posts: [{ type: Schema.Types.ObjectId, ref: 'Post' }],
  },
  { timestamps: true },
);

export const UserModel = model<UserProps>('User', UserSchema);
