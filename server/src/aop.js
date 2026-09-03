/**
 * aop.js — 轻量 AOP(面向切面编程)框架
 *
 * 参考 AOP 思想:将横切关注点(日志、鉴权、遥测采集、性能计时)与核心业务
 * 逻辑解耦。通过 Aspect 注册 before / after / around 通知,在目标方法执行
 * 时自动织入。
 *
 * 用法:
 *   const aop = new Aop();
 *   aop.aspect('telemetry.collect', {
 *     before(ctx) { ... },
 *     after(ctx) { ... }
 *   });
 *   const result = aop.proxy(target);   // 对对象方法织入切面
 */

export class AspectContext {
  constructor(method, target, args) {
    this.method = method;
    this.target = target;
    this.args = args;
    this.result = undefined;
    this.error = undefined;
    this.aborted = false;
    this.startTime = Date.now();
    this.meta = {};
  }
}

export class Aop {
  constructor() {
    /** @type {Map<string, Array<{before?:Function, after?:Function, around?:Function}>>} */
    this.registry = new Map();
    this.logger = console;
  }

  /**
   * 注册切面。pointcut 支持两种形式:
   *  - 全局模式 'methodName'          → 匹配所有同名方法
   *  - 对象限定模式 'targetName.method' → 匹配指定对象上的方法
   */
  aspect(pointcut, advice) {
    const list = this.registry.get(pointcut) || [];
    list.push(advice);
    this.registry.set(pointcut, list);
    return this;
  }

  /** 返回某 pointcut 匹配到的所有切面(含继承规则)。 */
  _match(pointcut, objectName, method) {
    const out = [];
    for (const [key, list] of this.registry) {
      if (key === method || key === `${objectName}.${method}` || key === '*') {
        out.push(...list);
      }
    }
    return out;
  }

  /**
   * 对对象织入切面:返回一个 Proxy,方法调用时按序执行
   * before → around → 原方法 → after。
   */
  proxy(target, objectName = '') {
    const self = this;
    return new Proxy(target, {
      get(obj, prop) {
        const value = obj[prop];
        if (typeof value !== 'function') return value;
        return function (...args) {
          const advices = self._match(`call:${String(prop)}`, objectName, String(prop));
          const ctx = new AspectContext(String(prop), obj, args);
          return self._execute(advices, ctx, value, obj);
        };
      },
    });
  }

  async _execute(advices, ctx, fn, obj) {
    const beforeList = advices.filter((a) => a.before);
    const afterList = advices.filter((a) => a.after);
    const aroundList = advices.filter((a) => a.around);

    // before 通知
    for (const a of beforeList) {
      try {
        await a.before(ctx);
      } catch (e) {
        ctx.error = e;
        this.logger?.error?.(`[AOP:before] ${ctx.method} 切面异常:`, e.message);
      }
      if (ctx.aborted) break;
    }

    if (!ctx.aborted) {
      // around 通知:链式调用,最内层执行原方法
      const run = async (i) => {
        if (i >= aroundList.length) {
          try {
            ctx.result = await fn.apply(obj, ctx.args);
          } catch (e) {
            ctx.error = e;
          }
          return ctx.result;
        }
        const a = aroundList[i];
        return a.around(ctx, () => run(i + 1));
      };
      try {
        await run(0);
      } catch (e) {
        ctx.error = e;
      }
    }

    // after 通知
    for (const a of afterList) {
      try {
        await a.after(ctx);
      } catch (e) {
        this.logger?.error?.(`[AOP:after] ${ctx.method} 切面异常:`, e.message);
      }
    }

    if (ctx.error && !ctx.aborted) throw ctx.error;
    if (ctx.aborted && ctx.meta.abortError) throw ctx.meta.abortError;
    return ctx.result;
  }
}

/** 预置切面工厂 */

/** 日志切面:记录方法调用参数与耗时。 */
export function loggingAspect(logger = console) {
  return {
    around: async (ctx, next) => {
      const t0 = Date.now();
      const result = await next();
      const ms = Date.now() - t0;
      logger.info(
        `[AOP:log] ${ctx.method}(${JSON.stringify(ctx.args)}) → ${ms}ms`
      );
      return result;
    },
  };
}

/**
 * 鉴权切面:校验调用上下文中的 token 与权限。
 * requireAuth(roles) 返回切面,ctx.meta.principal 由调用方注入。
 */
export function authAspect({ tokenValidator, failWith = new Error('AUTH_FAILED: 未授权') } = {}) {
  return {
    before: async (ctx) => {
      const token = ctx.meta?.token;
      if (!tokenValidator) {
        if (!token) {
          ctx.aborted = true;
          ctx.meta.abortError = failWith;
        }
        return;
      }
      const ok = await tokenValidator(token);
      if (!ok) {
        ctx.aborted = true;
        ctx.meta.abortError = failWith;
      }
    },
  };
}

/** 遥测采集切面:方法调用后把结果写入遥测存储。 */
export function telemetryCollectAspect(collector) {
  return {
    after: async (ctx) => {
      if (ctx.result && typeof collector === 'function') {
        await collector(ctx.method, ctx.result, ctx.meta);
      }
    },
  };
}
