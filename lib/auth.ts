import NextAuth, { type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { Role } from '@prisma/client';
import { authConfig } from '../auth.config';

const credentialsSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(1).max(200),
});

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: Role;
      username: string;
    } & DefaultSession['user'];
  }
  interface User {
    role: Role;
    username: string;
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    role: Role;
    username: string;
    userId: string;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(creds) {
        const parsed = credentialsSchema.safeParse(creds);
        if (!parsed.success) return null;
        const { username, password } = parsed.data;

        const user = await prisma.user.findUnique({ where: { username } });
        if (!user || !user.isActive) return null;

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return null;

        await prisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        });

        logger.info({ userId: user.id, username: user.username }, 'login.success');

        return {
          id: user.id,
          name: user.fullName,
          email: user.email ?? undefined,
          username: user.username,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    jwt({ token, user }) {
      if (user) {
        token.userId = user.id!;
        token.role = (user as { role: Role }).role;
        token.username = (user as { username: string }).username;
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = String(token.userId);
      session.user.role = token.role as Role;
      session.user.username = String(token.username);
      return session;
    },
  },
});
