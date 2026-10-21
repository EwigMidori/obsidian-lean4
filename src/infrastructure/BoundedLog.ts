/** Keeps server output useful without retaining an unbounded stderr stream. */
export class BoundedLog {
  private content = "";

  constructor(private readonly maximumCharacters = 16_384) {}

  append(message: string): void {
    this.content = (this.content + message).slice(-this.maximumCharacters);
  }

  read(): string {
    return this.content;
  }
}
