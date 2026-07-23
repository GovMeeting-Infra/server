import { IsString, IsEmail, Matches } from 'class-validator';

export class CreateMinistryDto {
  @IsString()
  name: string;

  @IsString()
  code: string;

  @IsString()
  @Matches(/^.+\.gov\.sl$/, {
    message: 'Email domain must end with .gov.sl',
  })
  emailDomain: string;
}
