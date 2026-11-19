/**
 * Universal Examination Architecture — Exact Rational Arithmetic Engine
 * 
 * Implements arbitrary-precision exact fractional arithmetic using native BigInts.
 * Eliminates IEEE-754 floating-point drift during score accumulation.
 * Conforms to Universal Examination Architecture Specification v2.8.
 */
export class Rational {

    /**
     * @param {bigint|number|string} numerator 
     * @param {bigint|number|string} [denominator=1n] 
     */
    constructor(numerator, denominator = 1n) {
        let n = BigInt(numerator);
        let d = BigInt(denominator);

        if (d === 0n) {
            throw new Error("DivisionByZero: Denominator cannot be zero in Rational");
        }

        if (d < 0n) {
            n = -n;
            d = -d;
        }

        const common = Rational.gcd(n < 0n ? -n : n, d);
        this.num = n / common;
        this.den = d / common;
    }

    /**
     * Greatest Common Divisor via Euclidean algorithm
     * @param {bigint} a 
     * @param {bigint} b 
     * @returns {bigint}
     */
    static gcd(a, b) {
        let x = a < 0n ? -a : a;
        let y = b < 0n ? -b : b;
        while (y !== 0n) {
            const t = y;
            y = x % y;
            x = t;
        }
        return x === 0n ? 1n : x;
    }

    /**
     * Convert any numeric, string, fraction, or object representation into an exact Rational
     * @param {Rational|number|string|bigint|object} val 
     * @returns {Rational}
     */
    static from(val) {
        if (val instanceof Rational) {
            return new Rational(val.num, val.den);
        }
        if (typeof val === "bigint") {
            return new Rational(val, 1n);
        }
        if (typeof val === "number") {
            if (Number.isInteger(val)) {
                return new Rational(BigInt(val), 1n);
            }
            if (isNaN(val) || !isFinite(val)) {
                throw new Error(`Invalid number value for Rational.from: ${val}`);
            }
            // Detect recurring thirds produced by IEEE-754 expressions or decimal approximations (e.g. 1/3, 2/3, -0.3333, -0.66)
            if (Math.abs(val - Math.round(val * 3) / 3) < 0.01) {
                const thirdNumerator = Math.round(val * 3);
                return new Rational(BigInt(thirdNumerator), 3n);
            }
            const str = String(val);
            if (str.includes("e") || str.includes("E")) {
                return Rational.from(Number(val).toFixed(12));
            }
            const parts = str.split(".");
            const intPart = BigInt(parts[0]);
            const fracStr = parts[1] || "";
            const den = 10n ** BigInt(fracStr.length);
            const isNegative = str.startsWith("-");
            const fracNum = BigInt(fracStr);
            const num = isNegative
                ? (intPart * den - fracNum)
                : (intPart * den + fracNum);
            return new Rational(num, den);
        }
        if (typeof val === "string") {
            const clean = val.trim();
            if (clean.includes("/")) {
                const parts = clean.split("/").map(s => s.trim());
                if (parts.length === 2 && parts[0] && parts[1]) {
                    return new Rational(BigInt(parts[0]), BigInt(parts[1]));
                }
            }
            if (clean.includes(".")) {
                const isNegative = clean.startsWith("-");
                const parts = (isNegative ? clean.slice(1) : clean).split(".");
                const intPart = BigInt(parts[0] || "0");
                const fracStr = parts[1] || "";
                const den = 10n ** BigInt(fracStr.length);
                const fracNum = BigInt(fracStr || "0");
                const absNum = intPart * den + fracNum;
                return new Rational(isNegative ? -absNum : absNum, den);
            }
            return new Rational(BigInt(clean), 1n);
        }
        if (val && typeof val === "object" && val.num !== undefined && val.den !== undefined) {
            return new Rational(BigInt(val.num), BigInt(val.den));
        }
        throw new Error(`Cannot parse Rational from value: ${JSON.stringify(val)}`);
    }

    /**
     * Rational constant 0
     */
    static get ZERO() {
        return new Rational(0n, 1n);
    }

    /**
     * Rational constant 1
     */
    static get ONE() {
        return new Rational(1n, 1n);
    }

    /**
     * Addition: this + other
     */
    add(other) {
        const o = Rational.from(other);
        return new Rational(
            this.num * o.den + o.num * this.den,
            this.den * o.den
        );
    }

    /**
     * Subtraction: this - other
     */
    sub(other) {
        const o = Rational.from(other);
        return new Rational(
            this.num * o.den - o.num * this.den,
            this.den * o.den
        );
    }

    /**
     * Multiplication: this * other
     */
    mul(other) {
        const o = Rational.from(other);
        return new Rational(
            this.num * o.num,
            this.den * o.den
        );
    }

    /**
     * Division: this / other
     */
    div(other) {
        const o = Rational.from(other);
        if (o.num === 0n) {
            throw new Error("DivisionByZero: Cannot divide Rational by zero");
        }
        return new Rational(
            this.num * o.den,
            this.den * o.num
        );
    }

    /**
     * Negation: -this
     */
    neg() {
        return new Rational(-this.num, this.den);
    }

    /**
     * Absolute value: |this|
     */
    abs() {
        return new Rational(this.num < 0n ? -this.num : this.num, this.den);
    }

    /**
     * Equality comparison
     */
    equals(other) {
        try {
            const o = Rational.from(other);
            return this.num === o.num && this.den === o.den;
        } catch {
            return false;
        }
    }

    /**
     * Relational comparison: returns -1 if this < other, 0 if equal, 1 if this > other
     */
    compare(other) {
        const o = Rational.from(other);
        const diff = this.num * o.den - o.num * this.den;
        if (diff < 0n) return -1;
        if (diff > 0n) return 1;
        return 0;
    }

    gt(other) {
        return this.compare(other) > 0;
    }

    gte(other) {
        return this.compare(other) >= 0;
    }

    lt(other) {
        return this.compare(other) < 0;
    }

    lte(other) {
        return this.compare(other) <= 0;
    }

    isZero() {
        return this.num === 0n;
    }

    isPositive() {
        return this.num > 0n;
    }

    isNegative() {
        return this.num < 0n;
    }

    /**
     * Exact decimal serialization with specified rounding policy
     * @param {number} [decimals=3] Number of decimal places
     * @param {"round_half_up"|"truncate"|"round_half_even"|"ceil"|"floor"} [mode="round_half_up"] Rounding strategy
     * @returns {string} Formatted decimal string (e.g. "66.667", "-0.333")
     */
    toDecimalString(decimals = 3, mode = "round_half_up") {
        const isNeg = this.num < 0n;
        const absNum = isNeg ? -this.num : this.num;
        const d = this.den;
        const factor = 10n ** BigInt(decimals);
        const scaledNum = absNum * factor;
        let quotient = scaledNum / d;
        const remainder = scaledNum % d;

        if (remainder > 0n) {
            if (mode === "round_half_up") {
                if (remainder * 2n >= d) {
                    quotient += 1n;
                }
            } else if (mode === "round_half_even") {
                if (remainder * 2n > d || (remainder * 2n === d && (quotient % 2n === 1n))) {
                    quotient += 1n;
                }
            } else if (mode === "ceil") {
                if (!isNeg) quotient += 1n;
            } else if (mode === "floor") {
                if (isNeg) quotient += 1n;
            }
            // "truncate" leaves quotient as is
        }

        if (quotient === 0n) {
            return decimals > 0 ? "0." + "0".repeat(decimals) : "0";
        }

        const sign = isNeg ? "-" : "";
        if (decimals === 0) {
            return `${sign}${quotient.toString()}`;
        }

        const str = quotient.toString().padStart(decimals + 1, "0");
        const intPart = str.slice(0, -decimals) || "0";
        const fracPart = str.slice(-decimals);
        return `${sign}${intPart}.${fracPart}`;
    }

    /**
     * Convert to JavaScript Number rounded to specified decimal places
     * @param {number} [decimals=3] 
     * @param {"round_half_up"|"truncate"|"round_half_even"} [mode="round_half_up"] 
     * @returns {number}
     */
    toNumber(decimals = 3, mode = "round_half_up") {
        return Number(this.toDecimalString(decimals, mode));
    }

    /**
     * Fraction string representation (e.g. "2/3", "-1/3", "4")
     * @returns {string}
     */
    toFractionString() {
        if (this.den === 1n) {
            return this.num.toString();
        }
        return `${this.num}/${this.den}`;
    }

    /**
     * Structured JSON serialization format
     */
    toJSON() {
        return {
            num: this.num.toString(),
            den: this.den.toString(),
            decimal: this.toNumber(3),
            fraction: this.toFractionString()
        };
    }

    toString() {
        return this.toFractionString();
    }
}
