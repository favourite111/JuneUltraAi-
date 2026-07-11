import { z } from "zod";
export declare const HealthCheckResponse: z.ZodObject<{
    status: z.ZodLiteral<"ok">;
}, "strip", z.ZodTypeAny, {
    status: "ok";
}, {
    status: "ok";
}>;
export type HealthCheckResponse = z.infer<typeof HealthCheckResponse>;
//# sourceMappingURL=index.d.ts.map