import { Module } from '@nestjs/common';
import { ContactTagsController } from './contact-tags.controller';
import { ContactTagsService } from './contact-tags.service';

/** Danh sách nhãn khách hàng (Quản trị → Nhãn). */
@Module({
  controllers: [ContactTagsController],
  providers: [ContactTagsService],
})
export class ContactTagsModule {}
