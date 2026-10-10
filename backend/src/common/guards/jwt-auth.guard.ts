import { ExecutionContext, Injectable, Optional, createParamDecorator } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { isSiteToken, SiteGameAuthService } from '../../modules/auth/site-game-auth.service';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
    constructor(@Optional() private readonly siteAuth?: SiteGameAuthService) { super(); }

    canActivate(context: ExecutionContext) {
        const request = context.switchToHttp().getRequest();
        const authorization = String(request.headers?.authorization || '');
        const token = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
        if (this.siteAuth && isSiteToken(token)) {
            return this.siteAuth.authenticate(token).then(user => { request.user = user; return true; });
        }
        return super.canActivate(context);
    }
}

export const CurrentUser = createParamDecorator((data, ctx) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;
    return data ? user?.[data] : user;
});
