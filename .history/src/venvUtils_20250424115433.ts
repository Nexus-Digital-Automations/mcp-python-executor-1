import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ServerConfig } from './config.js';
import { Logger, ExecutorError, ErrorCode } from './logger.js';

// Class to manage venv operations with locking
export class VenvManager {
  private venvLocks: Map<string, Promise<void>> = new Map();
  private logger: Logger;
  private config: ServerConfig;

  constructor(config: ServerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Validates venv name to prevent directory traversal and other security issues
   * @param venvName The name to validate
   * @throws {ExecutorError} If the venv name is invalid
   */
  validateVenvName(venvName: string): void {
    if (!venvName) {
      throw new ExecutorError(ErrorCode.INVALID_INPUT, 'Virtual environment name cannot be empty');
    }

    // Check length - not too short, not too long
    if (venvName.length < 1 || venvName.length > 64) {
      throw new ExecutorError(
        ErrorCode.INVALID_INPUT,
        'Virtual environment name must be between 1 and 64 characters'
      );
    }

    // Only allow alphanumeric characters, hyphen, underscore
    const validNameRegex = /^[a-zA-Z0-9_-]+$/;
    if (!validNameRegex.test(venvName)) {
      throw new ExecutorError(
        ErrorCode.INVALID_INPUT,
        'Virtual environment name can only contain letters, numbers, underscore and hyphen'
      );
    }

    // Disallow names that could be confused with special directories
    const disallowedNames = ['.', '..', 'node_modules', '.git', 'temp', 'tmp'];
    if (disallowedNames.includes(venvName.toLowerCase())) {
      throw new ExecutorError(
        ErrorCode.INVALID_INPUT,
        `"${venvName}" is not allowed as a virtual environment name`
      );
    }
  }

  /**
   * Get the absolute path to a specific virtual environment
   * @param venvName Name of the virtual environment (default: the configured default venv)
   * @returns The absolute path to the virtual environment
   */
  getVenvPath(venvName?: string): string {
    // Use the default venv name if none provided
    const targetVenvName = venvName || this.config.python.defaultVenvName;

    // Validate the venv name if provided
    if (venvName) {
      this.validateVenvName(targetVenvName);
    }

    // Get the base path and compose the full venv path
    const venvsBasePath = this.config.python.venvsBasePath;
    return path.join(venvsBasePath, targetVenvName);
  }

  /**
   * Get activation command and python executable path for a virtual environment
   * @param venvName Name of the virtual environment (optional)
   * @returns Object with activation command and paths
   */
  getActivationDetails(venvName?: string): { 
    activateCmd: string; 
    isWindows: boolean; 
    pythonExecutable: string;
    venvPath: string;
  } {
    const venvPath = this.getVenvPath(venvName);
    const isWindows = os.platform() === 'win32';
    let activateCmd = '';
    let pythonExecutable = '';

    if (isWindows) {
      activateCmd = `"${path.join(venvPath, 'Scripts', 'activate.bat')}" && `;
      pythonExecutable = path.join(venvPath, 'Scripts', 'python.exe');
    } else {
      activateCmd = `source "${path.join(venvPath, 'bin', 'activate')}" && `;
      pythonExecutable = path.join(venvPath, 'bin', 'python');
    }
    
    return { 
      activateCmd, 
      isWindows, 
      pythonExecutable,
      venvPath
    };
  }

  /**
   * Check if a virtual environment exists and is valid
   * @param venvName Name of the virtual environment (optional)
   * @returns Promise resolving to true if the venv exists, false otherwise
   */
  async checkVenvExists(venvName?: string): Promise<boolean> {
    try {
      const venvPath = this.getVenvPath(venvName);
      
      // Look for pyvenv.cfg which indicates a valid virtual environment
      const cfgPath = path.join(venvPath, 'pyvenv.cfg');
      
      // Also check for the python executable to ensure venv is complete
      const isWindows = os.platform() === 'win32';
      const pythonPath = path.join(
        venvPath, 
        isWindows ? 'Scripts/python.exe' : 'bin/python'
      );
      
      // Check for both configuration and executable
      await Promise.all([
        fs.access(cfgPath, fs.constants.F_OK),
        fs.access(pythonPath, fs.constants.F_OK | fs.constants.X_OK)
      ]);
      
      this.logger.debug('Virtual environment exists and appears valid', { venvPath });
      return true;
    } catch (error) {
      const venvPath = this.getVenvPath(venvName);
      this.logger.debug('Virtual environment does not exist or is incomplete', { venvPath });
      return false;
    }
  }

  /**
   * Execute a function with a lock on a specific virtual environment
   * @param venvName Name of the virtual environment to lock
   * @param fn Function to execute while the lock is held
   * @returns Promise resolving to the result of the function
   */
  async withVenvLock<T>(venvName: string, fn: () => Promise<T>): Promise<T> {
    // If no lock exists for this venv, create a resolved promise
    if (!this.venvLocks.has(venvName)) {
      this.venvLocks.set(venvName, Promise.resolve());
    }

    // Get the current promise chain for this venv
    const currentLock = this.venvLocks.get(venvName)!;

    // Create a new promise that will resolve when our operation completes
    let releaseLock: () => void;
    const newLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    // Update the lock in the map to be the new promise
    this.venvLocks.set(venvName, currentLock.then(() => newLock));

    try {
      // Wait for our turn in the lock queue
      await currentLock;
      // Execute the function while we hold the lock
      return await fn();
    } finally {
      // Release the lock when done
      releaseLock!();
    }
  }

  /**
   * Create a virtual environment if it doesn't exist
   * @param venvName Name of the virtual environment
   * @returns Promise that resolves when the environment is ready
   */
  async setupVirtualEnvironment(venvName?: string): Promise<void> {
    const targetVenvName = venvName || this.config.python.defaultVenvName;
    
    return this.withVenvLock(targetVenvName, async () => {
      // Get validated path
      const venvPath = this.getVenvPath(targetVenvName);
      this.logger.debug('Attempting to setup virtual environment', { path: venvPath });

      // Check if the venv already exists
      const venvExists = await this.checkVenvExists(targetVenvName);

      if (!venvExists) {
        this.logger.info('Creating virtual environment', { path: venvPath });
        
        // Ensure parent directories exist
        await fs.mkdir(path.dirname(venvPath), { recursive: true });

        // Use system's python to create the venv with pip
        try {
          // Create venv with pip support and without site packages (for isolation)
          const createCmd = `python -m venv --clear --without-pip "${venvPath}"`;
          await this.execCommand(createCmd);
          
          // Install pip using the ensurepip module
          const { activateCmd, isWindows } = this.getActivationDetails(targetVenvName);
          const pipInstallCmd = `${activateCmd}python -m ensurepip --upgrade`;
          
          // Execute with appropriate shell/timeout
          await this.execCommand(pipInstallCmd, {
            timeout: this.config.execution.packageTimeoutMs,
            env: { ...process.env },
            ...(isWindows ? { shell: 'cmd.exe' } : {})
          });
          
          this.logger.info('Successfully created virtual environment with pip', { path: venvPath });
        } catch (error) {
          this.logger.error('Failed to create virtual environment', { 
            path: venvPath, 
            error: error instanceof Error ? error.message : String(error) 
          });
          
          // Attempt to clean up potentially incomplete venv directory
          await fs.rm(venvPath, { recursive: true, force: true }).catch(rmErr => {
            this.logger.error('Failed to cleanup incomplete venv directory', { 
              path: venvPath, 
              error: rmErr instanceof Error ? rmErr.message : String(rmErr) 
            });
          });
          
          throw new ExecutorError(
            ErrorCode.INTERNAL_ERROR, 
            `Failed to create virtual environment: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      } else {
        this.logger.debug('Virtual environment already exists', { path: venvPath });
      }
    });
  }
  
  /**
   * Execute a shell command with proper error handling
   * @param command Command to execute
   * @param options Execution options
   * @returns Promise with stdout/stderr
   */
  private async execCommand(command: string, options: any = {}): Promise<{ stdout: string, stderr: string }> {
    const execAsync = promisify(exec);
    try {
      const result = await execAsync(command, options);
      return {
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString()
      };
    } catch (error: any) {
      // Enhance error with more context
      if (error.stdout) this.logger.debug('Command stdout before error', { stdout: error.stdout.toString() });
      if (error.stderr) this.logger.debug('Command stderr on error', { stderr: error.stderr.toString() });
      
      // Rethrow with context
      throw new Error(`Command failed: ${command}\n${error.message}`);
    }
  }
  
  /**
   * List all available virtual environments 
   * @returns Array of venv names
   */
  async listVenvs(): Promise<string[]> {
    const basePath = this.config.python.venvsBasePath;
    
    try {
      const entries = await fs.readdir(basePath, { withFileTypes: true });
      const venvNames: string[] = [];
      
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const cfgPath = path.join(basePath, entry.name, 'pyvenv.cfg');
          try {
            await fs.access(cfgPath);
            venvNames.push(entry.name);
          } catch { 
            // Ignore directories that aren't valid venvs
          }
        }
      }
      
      return venvNames;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // Base directory doesn't exist yet
        return [];
      }
      
      throw error;
    }
  }
  
  /**
   * Get details about available virtual environments
   * @returns Array of objects with venv information
   */
  async getVenvDetails(): Promise<Array<{
    name: string;
    path: string;
    isDefault: boolean;
    packages: number;
    description?: string;
  }>> {
    const venvNames = await this.listVenvs();
    const defaultName = this.config.python.defaultVenvName;
    const results = [];
    
    // Load descriptions from a metadata file if it exists
    const metadataPath = path.join(this.config.python.venvsBasePath, 'venv_metadata.json');
    let metadata: Record<string, { description?: string }> = {};
    
    try {
      const content = await fs.readFile(metadataPath, 'utf-8');
      metadata = JSON.parse(content);
    } catch {
      // Ignore if metadata file doesn't exist
    }
    
    for (const name of venvNames) {
      try {
        const venvPath = this.getVenvPath(name);
        const isDefault = name === defaultName;
        
        // Count packages in the environment
        let packageCount = 0;
        try {
          // This is approximate - we're just listing the site-packages directory
          const sitePkgPath = path.join(
            venvPath, 
            os.platform() === 'win32' ? 'Lib\\site-packages' : 'lib/python*/site-packages'
          );
          
          // Use glob pattern for Unix systems to find correct python version folder
          if (os.platform() !== 'win32') {
            const libPath = path.join(venvPath, 'lib');
            const pythonDirs = await fs.readdir(libPath);
            const pythonDir = pythonDirs.find(dir => dir.startsWith('python'));
            
            if (pythonDir) {
              const sitePackages = path.join(libPath, pythonDir, 'site-packages');
              const files = await fs.readdir(sitePackages);
              packageCount = files.filter(f => 
                (f.endsWith('.dist-info') || f.endsWith('.egg-info') || !f.includes('.'))
                && !['__pycache__', '.DS_Store'].includes(f)
              ).length;
            }
          } else {
            // Windows path is more straightforward
            const sitePackages = path.join(venvPath, 'Lib', 'site-packages');
            const files = await fs.readdir(sitePackages);
            packageCount = files.filter(f => 
              (f.endsWith('.dist-info') || f.endsWith('.egg-info') || !f.includes('.'))
              && !['__pycache__', '.DS_Store'].includes(f)
            ).length;
          }
        } catch {
          // If we can't count packages, just use 0
        }
        
        results.push({
          name,
          path: venvPath,
          isDefault,
          packages: packageCount,
          description: metadata[name]?.description
        });
      } catch (error) {
        this.logger.error(`Error getting details for venv ${name}`, { error });
      }
    }
    
    return results;
  }
  
  /**
   * Update or set the description for a virtual environment
   * @param venvName Name of the virtual environment
   * @param description New description
   */
  async setVenvDescription(venvName: string, description: string): Promise<void> {
    // Validate the venv name
    this.validateVenvName(venvName);
    
    // Check if the venv exists
    if (!(await this.checkVenvExists(venvName))) {
      throw new ExecutorError(
        ErrorCode.INVALID_INPUT,
        `Virtual environment "${venvName}" does not exist`
      );
    }
    
    // Load existing metadata
    const metadataPath = path.join(this.config.python.venvsBasePath, 'venv_metadata.json');
    let metadata: Record<string, { description?: string }> = {};
    
    try {
      const content = await fs.readFile(metadataPath, 'utf-8');
      metadata = JSON.parse(content);
    } catch {
      // If file doesn't exist, start with empty object
    }
    
    // Update the description
    metadata[venvName] = { 
      ...(metadata[venvName] || {}),
      description
    };
    
    // Save the metadata file
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
  }
  
  /**
   * Delete a virtual environment
   * @param venvName Name of the environment to delete
   * @param force Force deletion even if it's the default environment
   */
  async deleteVenv(venvName: string, force: boolean = false): Promise<void> {
    // Validate the venv name
    this.validateVenvName(venvName);
    
    // Don't allow deletion of the default environment unless forced
    if (venvName === this.config.python.defaultVenvName && !force) {
      throw new ExecutorError(
        ErrorCode.INVALID_INPUT,
        `Cannot delete the default environment "${venvName}" without force=true`
      );
    }
    
    return this.withVenvLock(venvName, async () => {
      const venvPath = this.getVenvPath(venvName);
      
      // Check if the environment exists
      const exists = await this.checkVenvExists(venvName);
      if (!exists) {
        this.logger.info(`Virtual environment "${venvName}" does not exist or was already deleted`);
        return;
      }
      
      // Remove the directory
      this.logger.info(`Deleting virtual environment "${venvName}"`, { path: venvPath });
      await fs.rm(venvPath, { recursive: true, force: true });
      
      // Update metadata to remove this venv
      const metadataPath = path.join(this.config.python.venvsBasePath, 'venv_metadata.json');
      try {
        let metadata: Record<string, any> = {};
        try {
          const content = await fs.readFile(metadataPath, 'utf-8');
          metadata = JSON.parse(content);
        } catch {
          // If file doesn't exist, use empty object
        }
        
        // Remove the deleted venv from metadata
        if (metadata[venvName]) {
          delete metadata[venvName];
          await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
        }
      } catch (error) {
        this.logger.error(`Error updating metadata after deleting venv "${venvName}"`, { error });
        // Continue even if metadata update fails
      }
    });
  }
} 