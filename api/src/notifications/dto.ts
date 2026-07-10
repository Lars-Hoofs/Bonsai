import {
  IsIn,
  isEmail,
  isURL,
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

/**
 * Validates `target` against the sibling `kind`:
 *  - 'slack' => must be an http(s) URL (a Slack incoming-webhook URL). The URL
 *    is re-validated against the SSRF guard at delivery time (`safeFetch`).
 *  - 'email' => must be a plain email address, delivered via SMTP.
 *
 * A single custom constraint is used rather than stacked `@ValidateIf` +
 * `@IsUrl`/`@IsEmail` decorators: two `@ValidateIf`s on one property interfere
 * (a false condition strips *all* validation on that property), which silently
 * lets mismatched targets — e.g. an email address for a `slack` kind — through.
 */
function IsHandoverTarget(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isHandoverTarget',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (typeof value !== 'string') return false;
          const kind = (args.object as CreateHandoverTargetDto).kind;
          if (kind === 'slack')
            return isURL(value, {
              require_protocol: true,
              protocols: ['http', 'https'],
            });
          if (kind === 'email') return isEmail(value);
          // Unknown kind — `@IsIn` on `kind` reports that separately.
          return false;
        },
        defaultMessage(args: ValidationArguments): string {
          const kind = (args.object as CreateHandoverTargetDto).kind;
          return kind === 'email'
            ? 'target must be a valid email address'
            : 'target must be a valid URL';
        },
      },
    });
  };
}

/**
 * Creates a per-project handover notification target. `kind` selects the
 * channel and dictates how `target` is validated (see {@link IsHandoverTarget}).
 */
export class CreateHandoverTargetDto {
  @IsIn(['slack', 'email']) kind!: 'slack' | 'email';

  @IsHandoverTarget() target!: string;
}
