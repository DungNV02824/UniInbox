import {
  type AuthUser,
  type ContactDetail,
  type UpdateContactRequest,
  updateContactSchema,
} from '@dezon/shared';
import { Body, Controller, Patch } from '@nestjs/common';
import { UuidParam } from '../../common/params';
import { toViewer } from '../../common/viewer';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { InboxService } from './inbox.service';

@Controller('contacts')
export class ContactsController {
  constructor(private readonly inbox: InboxService) {}

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @UuidParam() id: string,
    @Body(new ZodValidationPipe(updateContactSchema)) body: UpdateContactRequest,
  ): Promise<ContactDetail> {
    return this.inbox.updateContact(toViewer(user), id, body);
  }
}
