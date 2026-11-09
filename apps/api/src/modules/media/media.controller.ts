import { type MediaStorage, storeMedia } from '@dezon/core';
import type { UploadedMediaDto } from '@dezon/shared';
import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { MultipartFile } from '@fastify/multipart';
import { MEDIA_STORAGE, STORAGE_NOT_CONFIGURED_MESSAGE } from '../../infra/storage/storage.constants';
import { checkUpload } from './upload-policy';

/** Phần request do @fastify/multipart gắn vào (fastify không phải dependency trực tiếp). */
interface MultipartRequest {
  isMultipart(): boolean;
  file(): Promise<MultipartFile | undefined>;
}

const FILE_FIELD = 'file';
const MAX_FILENAME_LENGTH = 255;

const isFileTooLarge = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 'FST_REQ_FILE_TOO_LARGE';

@Controller('media')
export class MediaController {
  constructor(@Inject(MEDIA_STORAGE) private readonly storage: MediaStorage | null) {}

  /** Nhân viên tải tệp lên (multipart, field `file`) để đính vào tin gửi đi. */
  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  async upload(@Req() request: MultipartRequest): Promise<UploadedMediaDto> {
    const storage = this.storage;
    if (!storage) throw new ServiceUnavailableException(STORAGE_NOT_CONFIGURED_MESSAGE);
    if (!request.isMultipart()) {
      throw new UnsupportedMediaTypeException('Yêu cầu phải có dạng multipart/form-data');
    }
    const file = await request.file();
    if (!file || file.fieldname !== FILE_FIELD) {
      throw new BadRequestException(`Thiếu tệp trong trường "${FILE_FIELD}"`);
    }
    const data = await this.readFile(file);
    const check = checkUpload(file.mimetype, data);
    if (!check.ok) {
      if (check.reason === 'empty') throw new BadRequestException('Tệp rỗng');
      throw new UnsupportedMediaTypeException(
        check.reason === 'mime' ? 'Loại tệp không được hỗ trợ' : 'Nội dung tệp không khớp với định dạng',
      );
    }

    const filename = file.filename ? file.filename.slice(0, MAX_FILENAME_LENGTH) : undefined;
    const stored = await storeMedia(storage, {
      data,
      mime: check.mime,
      filename,
      type: check.type,
      prefix: 'uploads',
    });
    return {
      storageKey: stored.storage_key,
      type: stored.type,
      mime: stored.mime,
      size: stored.size,
      ...(stored.width ? { width: stored.width } : {}),
      ...(stored.height ? { height: stored.height } : {}),
      ...(stored.name ? { name: stored.name } : {}),
      url: await storage.signedUrl(stored.storage_key),
    };
  }

  private async readFile(file: MultipartFile): Promise<Buffer> {
    try {
      return await file.toBuffer();
    } catch (error) {
      if (isFileTooLarge(error)) {
        throw new HttpException('Tệp vượt quá dung lượng cho phép', HttpStatus.PAYLOAD_TOO_LARGE);
      }
      throw error;
    }
  }
}
