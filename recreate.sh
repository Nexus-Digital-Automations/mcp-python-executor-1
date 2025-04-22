# Activate the virtual environment
source /Users/jeremyparker/.mcp-python-venv/bin/activate

# Upgrade pip and setup tools
pip install --upgrade pip setuptools wheel

# Install packages mentioned in the config
pip install numpy pandas matplotlib scikit-learn

# Install uv package manager if you want to use it (optional)
pip install uv