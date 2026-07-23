import { IsOptional, IsString, Matches } from 'class-validator';

export class UpdateMinistryDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  @Matches(/^.+\.gov\.sl$/, {
    message: 'Email domain must end with .gov.sl',
  })
  emailDomain?: string;
}
