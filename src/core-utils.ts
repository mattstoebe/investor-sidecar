// IExpense is an interface that defines a method for getting the monthly expense of an expense
export interface IExpense {
    getMonthlyExpense(): number;
}

// PropertyTax is a class that implements the IExpense interfac
export class TaxExpense implements IExpense {
    constructor(private propertyValue: number, private annualTaxRate: number) {
        if (annualTaxRate < 0) {
            throw new Error("Tax Rate cannot be negative")
        }
        if(propertyValue < 0) {
            throw new Error("Property Value cannot be negative")
        }
    }

    public getMonthlyExpense(): number {
        return (this.propertyValue * this.annualTaxRate / 100)/12;
    }
}

// HOAExpense is a class that implements the IExpense interface for HOA fees
export class HOAExpense implements IExpense {
    constructor(private monthlyHOA: number | null | undefined) {
        if(monthlyHOA !== null && monthlyHOA !== undefined && monthlyHOA < 0) {
            throw new Error("HOA Amount cannot be negative")
        }
    }

    public getMonthlyExpense(): number {
        const amount = Number(this.monthlyHOA);
        return isNaN(amount) ? 0 : amount;
    }
}

/**
 * A monthly expense that is a flat percentage of a monthly amount: vacancy loss and
 * maintenance/CapEx reserves as a % of monthly rent, management fee as a % of
 * monthly collected (post-vacancy) rent.
 */
export class RateOfRentExpense implements IExpense {
    constructor(private monthlyBase: number, private ratePercent: number) {
        if (monthlyBase < 0) {
            throw new Error("Base amount cannot be negative");
        }
        if (ratePercent < 0) {
            throw new Error("Rate cannot be negative");
        }
    }

    public getMonthlyExpense(): number {
        return this.monthlyBase * this.ratePercent / 100;
    }
}

/**
 * A monthly expense stated as an annual percentage of a value: insurance as a % of
 * price, PMI as a % of loan amount. Same math as TaxExpense over a different base,
 * kept separate so each reads clearly at its call site.
 */
export class AnnualRateExpense implements IExpense {
    constructor(private baseValue: number, private annualRatePercent: number) {
        if (baseValue < 0) {
            throw new Error("Base value cannot be negative");
        }
        if (annualRatePercent < 0) {
            throw new Error("Rate cannot be negative");
        }
    }

    public getMonthlyExpense(): number {
        return (this.baseValue * this.annualRatePercent / 100) / 12;
    }
}

// MortgageCalculator is a class that calculates the monthly payment and loan amount for a mortgage
export class MortgageCalculator {
    private readonly price: number;
    private readonly downPayment: number;
    private readonly interestRate: number; // should come in as a whole number
    private readonly loanTerm: number;

    constructor(price: number, downPayment: number, interestRate: number, loanTerm: number) {
        if(price <= 0) {
            throw new Error("Price must be greater than 0")
        }
        if(downPayment < 0) {
            throw new Error("Down Payment must be positive")
        }
        if(downPayment > price) {
            throw new Error("Down Payment cannot be greater than the price")
        }
        if(interestRate < 0) {
            throw new Error("Interest Rate must be positive")
        }
        if(loanTerm <= 0) {
            throw new Error("Loan Term must be positive")
        }
        this.price = price;
        this.downPayment = downPayment;
        this.interestRate = interestRate;
        this.loanTerm = loanTerm;
    }
    public getLoanAmount(): number {
        return this.price - this.downPayment;
    }

    public getDownPayment(): number {
        return this.downPayment;
    }

    public getInitialInvestment(): number {
        return this.downPayment;
    }
    
    public calculateMonthlyPayment(): number {
        const loanAmount = this.getLoanAmount();
        const monthlyInterestRate = this.interestRate /100/12;
        const numberOfPayments = this.loanTerm * 12;
      
        // Special case: if interest rate is zero, simply divide the loan amount evenly.
        if (monthlyInterestRate === 0) {
          return loanAmount / numberOfPayments;
        }
      
        const factor = Math.pow(1 + monthlyInterestRate, numberOfPayments);
        const monthlyPayment = loanAmount * (monthlyInterestRate * factor) / (factor - 1);
        return monthlyPayment;
    }

    /**
     * Splits the level monthly payment into interest and principal for a given month
     * (1-indexed). Interest is charged on the remaining balance, so this requires
     * walking the amortization schedule up to that month.
     */
    public getPrincipalAndInterestForMonth(month: number): { principal: number; interest: number } {
        if (month < 1) {
            throw new Error("Month must be 1 or greater");
        }
        const payment = this.calculateMonthlyPayment();
        const monthlyRate = this.interestRate / 100 / 12;
        let balance = this.getLoanAmount();

        let interest = 0;
        let principal = 0;
        for (let m = 1; m <= month; m++) {
            interest = balance * monthlyRate;
            principal = payment - interest;
            balance -= principal;
        }
        return { principal, interest };
    }

    /**
     * What is still owed after `months` payments -- the figure a refinance pays off, and what
     * a flip settles at closing. Month 0 is the original loan, which is what a sale before the
     * first payment would clear.
     */
    public getBalanceAtMonth(months: number): number {
        if (months < 0) {
            throw new Error("Months cannot be negative");
        }
        if (months === 0) return this.getLoanAmount();
        // Never below zero: past the term the loan is simply paid off, and a negative balance
        // would read as the lender owing the borrower.
        return Math.max(0, this.getLoanAmount() - this.getCumulativePrincipalPaid(months));
    }

    /** Total principal paid down over the first `months` payments -- the equity a landlord builds via debt paydown. */
    public getCumulativePrincipalPaid(months: number): number {
        if (months < 1) {
            throw new Error("Months must be 1 or greater");
        }
        const payment = this.calculateMonthlyPayment();
        const monthlyRate = this.interestRate / 100 / 12;
        let balance = this.getLoanAmount();
        let totalPrincipal = 0;

        for (let m = 1; m <= months; m++) {
            const interest = balance * monthlyRate;
            const principal = payment - interest;
            balance -= principal;
            totalPrincipal += principal;
        }
        return totalPrincipal;
    }
}


// CashFlowMetrics is an interface that defines the metrics for the cash flow of a property. 
// it can be implemented for multiple types of properties but currenlty is only implemented for a single family home
export interface CashFlowMetrics {
    totalMonthlyExpenses: number;
    monthlyCashFlow: number;
    annualCashFlow: number;
    cashOnCashReturn: number; // expressed as a percentage
  }
export interface ICashFlowCalculator {
    calculateMetrics(): CashFlowMetrics;
}


// SingleFamilyCashFlowCalculator.ts
export class SingleFamilyCashFlowCalculator implements ICashFlowCalculator {
    /**
     * @param mortgageCalculator - Instance to compute the monthly mortgage payment (debt service)
     * @param monthlyIncome - Property's monthly income (e.g., rent)
     * @param additionalExpenses - Array of additional expenses (tax, HOA, etc.) implementing IExpense
     * @param additionalCashInvestment - Whatever additional cast you will put into property (used for cash-on-cash return calculation)
     */
    constructor(
        private mortgageCalculator: MortgageCalculator,
        private monthlyIncome: number,
        private additionalExpenses: IExpense[],
        private additionalCashInvestment: number
    ) {}

    public calculateMetrics(): CashFlowMetrics {
        const debtService = this.mortgageCalculator.calculateMonthlyPayment();

        const totalExtraExpenses = this.additionalExpenses.reduce(
            (sum, expense) => sum + expense.getMonthlyExpense(),
            0
        );

        const totalMonthlyExpenses = debtService + totalExtraExpenses;
        const monthlyCashFlow = this.monthlyIncome - totalMonthlyExpenses;
        const annualCashFlow = monthlyCashFlow * 12;
        
        const totalInvestment = this.mortgageCalculator.getInitialInvestment() + this.additionalCashInvestment;
        const cashOnCashReturn = ((monthlyCashFlow * 12) / totalInvestment) * 100;

        return {
            totalMonthlyExpenses,
            monthlyCashFlow,
            annualCashFlow,
            cashOnCashReturn
        }
    }
}

export class Sanitizer {
    /**
     * Converts a formatted string or a number into a plain number.
     * Removes dollar signs, commas, and whitespace.
     * @param input - The value to sanitize (e.g., "$300,000" or "  45000 ")
     * @returns A number representation of the input.
     */
    public static sanitizeNumber(input: string | number): number {
      if (typeof input === 'number') {
        return input;
      }
      // Remove dollar signs, commas, and any extra spaces.
      const cleaned = input.replace(/[$,\s]/g, '');
      const num = parseFloat(cleaned);
      if (isNaN(num)) {
        throw new Error(`Invalid number format: ${input}`);
      }
      return num;
    }
  }