export function parseArgs() {
    const args = process.argv.slice(2);
    const options: Record<string, string> = {};
  
    for (const arg of args) {
      if (arg.startsWith('--')) {
        const [key, value] = arg.slice(2).split('=');
        if (key && value) {
          options[key] = value;
        }
      }
    }
  
    return options;
}