import type { UserDirectoryEntry } from '@dezon/shared';
import { Controller, Get } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { type UserSummary, UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Roles('admin')
  @Get()
  list(): Promise<UserSummary[]> {
    return this.users.list();
  }

  /** Mọi nhân viên đăng nhập đều xem được (ô phân công); không trả email. */
  @Get('directory')
  directory(): Promise<UserDirectoryEntry[]> {
    return this.users.directory();
  }
}
