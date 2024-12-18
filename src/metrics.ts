export interface ExecutionMetrics {
    startTime: number;
    endTime: number;
    memoryUsageMb: number;
    success: boolean;
    error?: string;
}

export class MetricsCollector {
    private executions: number = 0;
    private errors: number = 0;
    private executionTimes: number[] = [];
    private memoryUsage: number[] = [];
    private startTime: number = Date.now();

    recordExecution(metrics: ExecutionMetrics) {
        this.executions++;

        const duration = metrics.endTime - metrics.startTime;
        this.executionTimes.push(duration);
        this.memoryUsage.push(metrics.memoryUsageMb);

        if (!metrics.success) {
            this.errors++;
        }
    }

    getStats() {
        const avgExecutionTime = this.executionTimes.length > 0
            ? this.executionTimes.reduce((a, b) => a + b, 0) / this.executionTimes.length
            : 0;

        const avgMemoryUsage = this.memoryUsage.length > 0
            ? this.memoryUsage.reduce((a, b) => a + b, 0) / this.memoryUsage.length
            : 0;

        return {
            totalExecutions: this.executions,
            totalErrors: this.errors,
            successRate: this.executions > 0
                ? ((this.executions - this.errors) / this.executions) * 100
                : 100,
            averageExecutionTimeMs: Math.round(avgExecutionTime),
            averageMemoryUsageMb: Math.round(avgMemoryUsage),
            uptime: Date.now() - this.startTime,
            lastExecutionTimes: this.executionTimes.slice(-5),
            lastMemoryUsages: this.memoryUsage.slice(-5)
        };
    }

    reset() {
        this.executions = 0;
        this.errors = 0;
        this.executionTimes = [];
        this.memoryUsage = [];
        this.startTime = Date.now();
    }
}

// Singleton instance
export const metrics = new MetricsCollector();
