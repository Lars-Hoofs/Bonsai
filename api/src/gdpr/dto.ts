import { IsString, Length } from 'class-validator';

/**
 * Identifies the data subject whose personal data is exported / erased. A
 * subject is a widget visitor, addressed by their `visitor_id` (the stable
 * pseudonymous identifier stored on `conversations.visitor_id`). All
 * conversations sharing that `visitor_id` within the (tenant, project)
 * scope — plus their messages, citations, handovers and feedback — form the
 * subject's data set.
 */
export class SubjectQueryDto {
  @IsString()
  @Length(1, 512)
  visitorId!: string;
}
