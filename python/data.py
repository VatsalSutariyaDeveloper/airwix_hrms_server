import pandas as pd
import random
from faker import Faker

fake = Faker('en_IN')
num_records = 10

data = []

# Sets to track uniqueness
used_emp_codes = set()
used_emails = set()
used_mobiles = set()
used_pan = set()
used_aadhaar = set()
used_uan = set()
used_driving_license = set()
used_voter_id = set()
used_bank_account = set()

print(f"Generating {num_records} unique records... please wait.")

while len(data) < num_records:
    # 1. Unique Employee Code
    emp_code = f"EMP-{len(data) + 1}"
    
    # 2. Unique Mobile (10 digits)
    mobile = f"{random.randint(6000000000, 9999999999)}"
    if mobile in used_mobiles: continue
    
    # 3. Unique Email
    first_name = fake.first_name()
    last_name = fake.last_name()
    email = f"{first_name.lower()}.{last_name.lower()}{len(data)}@example.com"
    
    # 4. Unique PAN (Format: 5 Alpha, 4 Numeric, 1 Alpha)
    pan = f"{''.join(random.choices('ABCDEFGHIJKLMNOPQRSTUVWXYZ', k=5))}{random.randint(1000, 9999)}{random.choice('ABCDEFGHIJKLMNOPQRSTUVWXYZ')}"
    if pan in used_pan: continue
    
    # 5. Unique Aadhaar (Format: 9999 9999 9999)
    raw_aadhaar = random.randint(100000000000, 999999999999)
    if raw_aadhaar in used_aadhaar: continue
    aadhaar_str = str(raw_aadhaar)
    formatted_aadhaar = f"{aadhaar_str[:4]} {aadhaar_str[4:8]} {aadhaar_str[8:]}"
    
    # 6. Unique UAN (12 digit integer)
    uan = random.randint(100000000000, 999999999999)
    if uan in used_uan: continue
    
    # 7. Unique Driving License Number
    driving_license = f"DL{random.randint(10000000, 99999999)}"
    if driving_license in used_driving_license: continue
    
    # 8. Unique Voter ID
    voter_id = f"VOT{random.randint(1000000, 9999999)}"
    if voter_id in used_voter_id: continue
    
    # 9. Unique Bank Account Number (12 digit integer)
    bank_account = random.randint(100000000000, 999999999999)
    if bank_account in used_bank_account: continue

    # Add to tracking sets
    used_mobiles.add(mobile)
    used_pan.add(pan)
    used_aadhaar.add(raw_aadhaar)
    used_uan.add(uan)
    used_driving_license.add(driving_license)
    used_voter_id.add(voter_id)
    used_bank_account.add(bank_account)

    full_name = f"{first_name} {last_name}".upper()
    same_as_current = random.choice([True, False])
    
    # Generate present address first
    present_addr1 = fake.street_address().replace(',', '')
    present_addr2 = fake.street_address().replace(',', '')
    present_city = fake.city()
    present_pincode = random.randint(110001, 850001)
    present_state = fake.state()
    
    # Set permanent address based on same_as_current flag
    if same_as_current:
        perm_addr1 = present_addr1
        perm_addr2 = present_addr2
        perm_city = present_city
        perm_pincode = present_pincode
        perm_state = present_state
    else:
        perm_addr1 = fake.street_address().replace(',', '')
        perm_addr2 = fake.street_address().replace(',', '')
        perm_city = fake.city()
        perm_pincode = random.randint(110001, 850001)
        perm_state = fake.state()

    row = {
        "Department": f"DEPT_{len(data) + 1}",
        "Designation": f"DES_{len(data) + 1}",
        "Employee Code": emp_code,
        "First Name": first_name,
        "Mobile No": mobile,
        "Attendance Supervisor": random.randint(500, 550),
        "Is Attendance Supervisor": random.choice([True, False]),
        "Reporting Manager": random.randint(200, 250),
        "Is Reporting Manager": random.choice([True, False]),
        "Gender": random.choice([1, 2, 3]),
        "Dob": fake.date_of_birth(minimum_age=20, maximum_age=55).strftime('%Y-%m-%d'),
        "Email": email,
        "Marital Status": random.choice([1, 2]),
        "Blood Group": random.randint(1, 8),
        "Physically Challenged": random.choice([True, False]),
        "Emergency Contact Mobile": f"{random.randint(6000000000, 9999999999)}",
        "Father Name": fake.name_male(),
        "Mother Name": fake.name_female(),
        "Spouse Name": fake.name() if random.choice([True, False]) else "",
        "Same As Current": same_as_current,
        "Permanent Address1": perm_addr1,
        "Permanent Address2": perm_addr2,
        "Permanent City": perm_city,
        "Permanent Pincode": perm_pincode,
        "Permanent State": perm_state,
        "Permanent Country": 101,
        "Present Address1": present_addr1,
        "Present Address2": present_addr2,
        "Present City": present_city,
        "Present Pincode": present_pincode,
        "Present State": present_state,
        "Present Country": 101,
        "Joining Date": fake.date_between(start_date='-10y', end_date='today').strftime('%Y-%m-%d'),
        "Uan Number": uan,
        "Name As Per Pan": full_name,
        "Pan Number": pan,
        "Name As Per Aadhaar": full_name,
        "Aadhaar Number": formatted_aadhaar,
        "Pf Number": f"PF/REGEN/{random.randint(1000000, 9999999)}",
        "Pf Joining Date": fake.date_between(start_date='-10y', end_date='today').strftime('%Y-%m-%d'),
        "Pf Eligible": True,
        "Esi Eligible": random.choice([True, False]),
        "Esi Number": random.randint(1000000000, 9999999999),
        "Pt Eligible": True,
        "Lwf Eligible": True,
        "Eps Eligible": True,
        "Eps Joining Date": None,
        "Eps Exit Date": None,
        "Hps Eligible": False,
        "Driving License Number": driving_license,
        "Voter Id Number": voter_id,
        "Name As Per Bank": full_name,
        "Bank Name": random.choice(["HDFC Bank", "State Bank of India", "ICICI Bank", "Axis Bank"]),
        "Bank Account Number": bank_account, # 12 Digit Integer
        "Bank Ifsc Code": f"{random.choice(['HDFC', 'SBIN', 'ICIC', 'UTIB'])}0{random.randint(100000, 999999)}",
        "Bank Account Holder Name": full_name,
        "Upi Id": f"{first_name.lower()}.{len(data)}@okbank"
    }
    data.append(row)

# Exporting
df = pd.DataFrame(data)
df.to_csv("unique_employee_data.csv", index=False)

print(f"Done! {num_records} rows exported to 'unique_employee_data.csv'.")