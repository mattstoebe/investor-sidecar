import { describe, expect, it,} from 'vitest';
import {
    IExpense, TaxExpense, HOAExpense, MortgageCalculator, SingleFamilyCashFlowCalculator,
    RateOfRentExpense, AnnualRateExpense
} from "../src/core-utils";

describe("TaxExpense",() => {
    it("should reject negative property value", () => {
        expect(() => new TaxExpense(-100000, 1.5)).toThrow("Property Value cannot be negative")
    })
    it("should reject negative tax rate", () => {
        expect(() => new TaxExpense(100000, -1.5)).toThrow("Tax Rate cannot be negative")
    })
    it("should calculate monthly expense correctly", () => {
        const taxExpense = new TaxExpense(100000, .82);
        expect(taxExpense.getMonthlyExpense()).toBeCloseTo(68.33, 2)
    }) 
})


describe("HOAExpense", () => {
    it("should reject negative HOA amount", () => {
        expect(() => new HOAExpense(-100)).toThrow("HOA Amount cannot be negative")
    })
    it("should return 0 for no HOA", () => {
        const hoaExpense = new HOAExpense(null);
        expect(hoaExpense.getMonthlyExpense()).toBe(0)
    })
})

describe("MortgageCalculator", () => {
    it("should reject negative price", () => {
        expect(() => new MortgageCalculator(-100000, 100000, 5, 30)).toThrow("Price must be greater than 0")
    })
    it("should reject negative down payment", () => {
        expect(() => new MortgageCalculator(100000, -100000, 5, 30)).toThrow("Down Payment must be positive")
    })
    it("should reject down payment greater than price", () => {
        expect(() => new MortgageCalculator(100000, 110000, 5, 30)).toThrow("Down Payment cannot be greater than the price")
    })  
    it("should reject negative interest rate", () => {
        expect(() => new MortgageCalculator(100000, 100000, -5, 30)).toThrow("Interest Rate must be positive")
    })
    it("should calculate monthly payment correctly", () => {
        const mortgage = new MortgageCalculator(200000, 0, 5, 30);
        expect(mortgage.calculateMonthlyPayment()).toBeCloseTo(1073.64)
    })
    it("should calculate monthly payment correctly", () => {
        const mortgage = new MortgageCalculator(200000, 20000, 5, 30);
        expect(mortgage.calculateMonthlyPayment()).toBeCloseTo(966.28)
    })   
})


describe("SingleFamilyCashFlowCalculator", () => {
    it("should calculate cash flow metrics correctly", () => {
      // ---- Input Parameters ----
      const price = 300000;              // Purchase price of the property
      const downPayment = 60000;         // Down payment used in the mortgage
      const interestRate = 0.04;         // Annual interest rate (4%)
      const loanTerm = 30;               // Loan term in years
      const monthlyIncome = 2000;        // Monthly rental income from the property
      const taxRate = 1.2;               // Property tax rate (percentage)
      const hoaFee = 150;                // Monthly HOA fee (if any)
      const additionalCashInvestment = 10000; // Any extra upfront investment (e.g., closing costs)

      // ---- Create Instances of Our Modules ----
      // MortgageCalculator calculates loan info (loan amount and monthly payment)
      const mortgageCalc = new MortgageCalculator(price, downPayment, interestRate, loanTerm);
      
      // Expense instances (they implement the IExpense interface)
      const taxExpense = new TaxExpense(price, taxRate);
      const hoaExpense = new HOAExpense(hoaFee);
      const expenses: IExpense[] = [taxExpense, hoaExpense];
  
      // Create the SingleFamilyCashFlowCalculator by passing:
      // - The mortgage calculator instance (debt service)
      // - The monthly income
      // - An array of additional expenses
      // - The additional investment amount (which, combined with down payment, is the total cash invested)
      const cashFlowCalc = new SingleFamilyCashFlowCalculator(
        mortgageCalc,
        monthlyIncome,
        expenses,
        additionalCashInvestment
      );
  
      // ---- Calculate Metrics Using Our Class ----
      const metrics = cashFlowCalc.calculateMetrics();
  
      // ---- Compute Expected Values ----
      // Debt Service: monthly mortgage payment calculated by MortgageCalculator.
      const debtService = mortgageCalc.calculateMonthlyPayment();
  
      // Additional Expenses:
      // TaxExpense: monthly tax = (purchasePrice * (taxRate / 100)) / 12.
      const expectedTaxExpense = (price * (taxRate / 100)) / 12; // For 300000 and 1.2%, equals 300000*0.012/12 = 300.
      // HOAExpense: simply the fee provided.
      const expectedExtraExpenses = expectedTaxExpense + hoaFee; // 300 + 150 = 450.
  
      // Total Monthly Expenses: mortgage payment + extra expenses.
      const expectedTotalMonthlyExpenses = debtService + expectedExtraExpenses;
  
      // Monthly Cash Flow: monthly income minus total monthly expenses.
      const expectedMonthlyCashFlow = monthlyIncome - expectedTotalMonthlyExpenses;
  
      // Annual Cash Flow: monthly cash flow multiplied by 12.
      const expectedAnnualCashFlow = expectedMonthlyCashFlow * 12;
  
      // Total Initial Investment: sum of the down payment from the mortgage and any additional investment.
      const totalInitialInvestment = downPayment + additionalCashInvestment;
  
      // Cash-on-Cash Return: (annual cash flow / total initial investment) * 100.
      const expectedCashOnCashReturn = totalInitialInvestment > 0 
        ? (expectedAnnualCashFlow / totalInitialInvestment) * 100 
        : 0;
  
      // ---- Assertions ----
      expect(metrics.totalMonthlyExpenses).toBeCloseTo(expectedTotalMonthlyExpenses, 2);
      expect(metrics.monthlyCashFlow).toBeCloseTo(expectedMonthlyCashFlow, 2);
      expect(metrics.annualCashFlow).toBeCloseTo(expectedAnnualCashFlow, 2);
      expect(metrics.cashOnCashReturn).toBeCloseTo(expectedCashOnCashReturn, 2);
    });
  });

describe("RateOfRentExpense", () => {
    it("computes a flat percentage of the monthly base", () => {
        const vacancy = new RateOfRentExpense(2000, 5);
        expect(vacancy.getMonthlyExpense()).toBeCloseTo(100, 2);
    });
    it("rejects a negative base", () => {
        expect(() => new RateOfRentExpense(-2000, 5)).toThrow("Base amount cannot be negative");
    });
    it("rejects a negative rate", () => {
        expect(() => new RateOfRentExpense(2000, -5)).toThrow("Rate cannot be negative");
    });
    it("returns 0 at a 0% rate", () => {
        expect(new RateOfRentExpense(2000, 0).getMonthlyExpense()).toBe(0);
    });
});

describe("AnnualRateExpense", () => {
    it("divides an annual percentage of the base by 12", () => {
        // $400,000 at 0.35%/yr insurance ~= $116.67/mo
        const insurance = new AnnualRateExpense(400000, 0.35);
        expect(insurance.getMonthlyExpense()).toBeCloseTo(116.67, 2);
    });
    it("rejects a negative base value", () => {
        expect(() => new AnnualRateExpense(-400000, 0.35)).toThrow("Base value cannot be negative");
    });
    it("rejects a negative rate", () => {
        expect(() => new AnnualRateExpense(400000, -0.35)).toThrow("Rate cannot be negative");
    });
});

describe("MortgageCalculator amortization", () => {
    // $320,000 loan at 7%/30yr: payment ~$2,129.11/mo, first month interest ~$1,866.67
    const mortgage = new MortgageCalculator(400000, 80000, 7, 30);

    it("splits month 1 into interest (on the full balance) and principal", () => {
        const { principal, interest } = mortgage.getPrincipalAndInterestForMonth(1);
        expect(interest).toBeCloseTo(1866.67, 1);
        expect(principal + interest).toBeCloseTo(mortgage.calculateMonthlyPayment(), 4);
    });

    it("increases the principal share of the payment over time", () => {
        const month1 = mortgage.getPrincipalAndInterestForMonth(1);
        const month12 = mortgage.getPrincipalAndInterestForMonth(12);
        expect(month12.principal).toBeGreaterThan(month1.principal);
        expect(month12.interest).toBeLessThan(month1.interest);
    });

    it("rejects a month below 1", () => {
        expect(() => mortgage.getPrincipalAndInterestForMonth(0)).toThrow("Month must be 1 or greater");
    });

    it("accumulates 12 months of principal paydown as real equity", () => {
        const cumulative = mortgage.getCumulativePrincipalPaid(12);
        const manualSum = Array.from({ length: 12 }, (_, i) =>
            mortgage.getPrincipalAndInterestForMonth(i + 1).principal
        ).reduce((a, b) => a + b, 0);
        expect(cumulative).toBeCloseTo(manualSum, 6);
        expect(cumulative).toBeGreaterThan(0);
    });

    it("a zero-interest loan pays down evenly with zero interest", () => {
        const zeroRate = new MortgageCalculator(120000, 0, 0, 10);
        const { principal, interest } = zeroRate.getPrincipalAndInterestForMonth(1);
        expect(interest).toBe(0);
        expect(principal).toBeCloseTo(zeroRate.calculateMonthlyPayment(), 6);
    });
});
