import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.get<string[]>(
      'roles',
      context.getHandler(),
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user || request.session?.user;

    if (!user) {
      throw new ForbiddenException('No user in request');
    }

    if (!requiredRoles.includes(user.systemRole)) {
      throw new ForbiddenException(
        `User role ${user.systemRole} is not authorized. Required: ${requiredRoles.join(', ')}`,
      );
    }

    return true;
  }
}
