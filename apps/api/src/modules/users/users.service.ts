import { type Db, users } from '@dezon/db';
import type { UserDirectoryEntry, UserRole } from '@dezon/shared';
import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DB } from '../../infra/db/db.constants';

/** Thông tin nhân viên trả về client — KHÔNG BAO GIỜ chứa password_hash. */
export interface UserSummary {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  isActive: boolean;
  createdAt: Date;
}

@Injectable()
export class UsersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  list(): Promise<UserSummary[]> {
    return this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        isActive: users.isActive,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(asc(users.createdAt), asc(users.email));
  }

  /** Nhân viên đang hoạt động, sắp theo tên. */
  directory(): Promise<UserDirectoryEntry[]> {
    return this.db
      .select({ id: users.id, name: users.name, role: users.role })
      .from(users)
      .where(eq(users.isActive, true))
      .orderBy(asc(users.name), asc(users.id));
  }
}
